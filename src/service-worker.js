import { retrieveEvidence, savedFieldCandidates, searchEvidence, selectPlannerEvidence, rankSuggestionEvidence, narrativeEvidence, semanticEligible, semanticRecordRevision } from './retrieval.js';
import { inferSensitivity, isOpaqueIdentifier, validateFillValue, meaningCompatible, suggestionTargetKey } from './core.js';
import { callAnswerPlanner, callAnswerRewriter, callAnswerSuggestions, callFormInterpreter, DEFAULT_FIREWORKS_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_PROVIDER } from './llm.js';
import { prepareFormScreenshot } from './form-screenshot.js';
import { upsertAnswerRecords, mergeLearnedAnswers, normalizeAnswerRecord } from './core.js';
import {
  createDatasourceState,
  mergeDatasource,
  mergeAnswerRecords,
  parseDatasourceBackup,
  serializeDatasourceBackup,
  seedDatasource,
  confirmBundledPublicLinks,
  BUNDLED_SEED_ID,
  shouldSeedDatasource,
} from './datasource.js';
import { exactVisibleChoice, planDeterministicFill, requiresVisibleChoiceMatch } from './form-engine.js';
import { buildLearningCandidates, callLearningReviewer } from './learning-review.js';
import { hostnameFromUrl, isHostnameDisabled, isSupportedSiteUrl, normalizeHostname, normalizeHostnames } from './site-control.js';
import { createSemanticMatcher, semanticFingerprint } from './typesafe.js';
import { createPhoenixTrace, flushPhoenixQueue, tracePhoenixEvent } from './phoenix.js';
import { createBrowserController, mergeAccessibilityInspection } from './browser-control.js';

const RUN_STORAGE_KEY = 'applicationRun';
const PHOENIX_ACTIVE_ACTIONS_KEY = 'phoenixActiveActions';
const MAX_PAGES = 20;
const ACTIVE_RUN_STATUSES = new Set(['running', 'waiting_user', 'page_ready', 'ready_for_user_submit']);
const FORM_SESSION_STATUSES = new Set([...ACTIVE_RUN_STATUSES, 'answers_saved']);
const SAVABLE_RUN_STATUSES = new Set(['waiting_user', 'page_ready', 'ready_for_user_submit', 'answers_saved']);
const processingTabs = new Set();
const backgroundJobs = new Map();
const semanticMatcher = createSemanticMatcher();
const WORKER_ID = `${Date.now()}:${Math.random()}`;
const saveLocks = new Set();
const saveOperations = new Map();
const reviewedCandidateCache = new WeakMap();
const MAX_DRAFT_CHARS = 4_000;
const MAX_REWRITE_INSTRUCTION_CHARS = 4_000;
let datasourceWriteChain = Promise.resolve();
let bundledSeedPromise = null;
let runWriteChain = Promise.resolve();
const INLINE_STORAGE_KEY = 'inlineFieldSessions';
const INLINE_TTL_MS = 10 * 60 * 1000;
let inlineWriteChain = Promise.resolve();
const inlineSessionAuthorities = new Map();
// Reserve individual draft destinations, including work queued behind the planner.
const draftFieldOwners = new Map();
let datasourceInitPromise = null;

const APPLICATION_TITLE_PATTERN = /\b(?:apply|application|candidate|profile|resume|experience|education)\b/i;
const UTILITY_FRAME_PATTERN = /\b(?:search|cookie|job[\s-]?alerts?|talent[\s-]?communities?|subscribe|feedback)\b/i;
const NO_APPLICATION_FRAME_REASON = 'No supported application controls were found. Retry the scan after the form loads, or complete inaccessible controls manually.';
const AMBIGUOUS_APPLICATION_FRAME_REASON = 'More than one application form was found. Click Select form, then click a field in the form you want to fill.';
const formSelections = new Map();
const debugSelections = new Map();
const formInterpretationCache = new Map();
const activeFormInterpretations = new Map();
const browserController = createBrowserController();
const FORM_SELECTION_TTL_MS = 60_000;
const DISCOVERY_REASONS = {
  no_supported_controls: NO_APPLICATION_FRAME_REASON,
  ambiguous_form: AMBIGUOUS_APPLICATION_FRAME_REASON,
  script_unavailable: 'The extension could not access this page. Reload it and retry the scan.',
  inspection_error: 'The form could not be inspected. Retry the scan.',
  loading_timeout: 'The form did not finish loading. Wait for it to load, then retry the scan.',
  destination_changed: 'The selected form changed. Retry the scan before filling more details.',
  form_interpretation_timeout: 'The form interpretation request timed out. Retry the scan, or select the form manually.',
};
const DISABLED_SITE_REASON = 'The extension is disabled on this site. Re-enable it from the side panel to use autofill.';
const INACTIVE_FORM_REASON = 'Press Fill this form to enable autofill for this form.';
const SITE_SETTINGS_KEY = 'disabledHostnames';
const siteRevisions = new Map();
let phoenixActionWriteChain = Promise.resolve();

async function readPhoenixActions() {
  const stored = await chrome.storage.local.get({[PHOENIX_ACTIVE_ACTIONS_KEY]: {}});
  return stored[PHOENIX_ACTIVE_ACTIONS_KEY] && typeof stored[PHOENIX_ACTIVE_ACTIONS_KEY] === 'object'
    ? stored[PHOENIX_ACTIVE_ACTIONS_KEY] : {};
}

function updatePhoenixActions(change) {
  const operation = phoenixActionWriteChain.catch(() => {}).then(async () => {
    const actions = await readPhoenixActions();
    const next = change(actions) || actions;
    await chrome.storage.local.set({[PHOENIX_ACTIVE_ACTIONS_KEY]: next});
  });
  phoenixActionWriteChain = operation.catch(error => {
    console.warn('Phoenix active-action metadata was not persisted.', error?.message || error);
  });
  return operation.catch(() => false);
}

function persistPhoenixAction(traceContext, name, sessionId, attributes = {}) {
  // Keep interruption metadata only while developer tracing is active.
  if (!chrome.runtime?.id) return Promise.resolve(false);
  const key = `${traceContext.traceId}:${traceContext.spanId}`;
  return chrome.storage.local.get({developerMode: false, phoenixTracing: true}).then(settings => {
    if (settings.developerMode !== true || settings.phoenixTracing === false) return false;
    return updatePhoenixActions(actions => ({...actions, [key]: {
    key, name, sessionId, traceContext: {...traceContext}, attributes: {...attributes}, startedAt: traceContext.startedAt || new Date().toISOString(),
    }}));
  }).catch(() => false);
}

function clearPhoenixAction(traceContext) {
  if (!traceContext?.traceId || !traceContext?.spanId) return Promise.resolve();
  const key = `${traceContext.traceId}:${traceContext.spanId}`;
  return updatePhoenixActions(actions => {
    const next = {...actions};
    delete next[key];
    return next;
  });
}

async function recoverPhoenixActions() {
  let actions;
  try { actions = await readPhoenixActions(); } catch { return; }
  await chrome.storage.local.set({[PHOENIX_ACTIVE_ACTIONS_KEY]: {}});
  for (const action of Object.values(actions)) {
    const traceContext = {...(action.traceContext || {}), startedAt: action.startedAt || action.traceContext?.startedAt};
    await tracePhoenixEvent(action.name || 'fill_page', {...(action.attributes || {}), 'ai.interrupted': true}, action.sessionId || traceContext.sessionId || '', {
      traceContext, root: true, statusCode: 'ERROR', statusMessage: 'worker_interrupted',
      output: {retained: false, interrupted: true, reason: 'worker_interrupted'},
    });
  }
}

function siteRevision(tabId) {
  return siteRevisions.get(tabId) || 0;
}

function bumpSiteRevision(tabId) {
  const next = siteRevision(tabId) + 1;
  siteRevisions.set(tabId, next);
  return next;
}

async function getDisabledHostnames() {
  const stored = await chrome.storage.local.get({ [SITE_SETTINGS_KEY]: [] });
  return normalizeHostnames(stored[SITE_SETTINGS_KEY]);
}

async function tabForSite(tabId, tabHint = null) {
  if (tabHint?.url) return tabHint;
  if (typeof chrome.tabs?.get === 'function') {
    try { return await chrome.tabs.get(tabId); } catch { /* tab may have closed */ }
  }
  return null;
}

async function siteStateForTab(tabId, tabHint = null) {
  const tab = await tabForSite(tabId, tabHint);
  const url = typeof tab?.url === 'string' ? tab.url : '';
  const hostname = isSupportedSiteUrl(url) ? hostnameFromUrl(url) : '';
  const disabledHostnames = await getDisabledHostnames();
  return {
    hostname,
    supported: Boolean(hostname),
    disabled: Boolean(hostname && isHostnameDisabled(hostname, disabledHostnames)),
    disabledHostnames,
  };
}

function siteStateReply(state) {
  return {
    hostname: state.hostname,
    supported: state.supported,
    disabled: state.disabled,
    disabledHostnames: state.disabledHostnames,
    sessionActive: state.sessionActive === true,
    enabled: state.supported && !state.disabled && state.sessionActive === true,
  };
}

async function assertTabSiteEnabled(tabId, expectedRevision = null) {
  const tabHint = expectedRevision && typeof expectedRevision === 'object' ? expectedRevision : null;
  if (tabHint) expectedRevision = null;
  if (expectedRevision !== null && siteRevision(tabId) !== expectedRevision) throw new Error(DISABLED_SITE_REASON);
  const state = await siteStateForTab(tabId, tabHint);
  if (!state.supported || state.disabled) throw new Error(DISABLED_SITE_REASON);
  if (expectedRevision !== null && siteRevision(tabId) !== expectedRevision) throw new Error(DISABLED_SITE_REASON);
  return state;
}

function formSessionMatchesTab(run, tab) {
  if (!run || !FORM_SESSION_STATUSES.has(run.status)) return false;
  const url = typeof tab?.url === 'string' ? tab.url : '';
  if (!url) return !run.frame || run.status === 'running';
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  // The selected form may live in an iframe whose URL differs from the
  // top-level tab URL. Authorization is therefore tied to the tab's form
  // origin, not the selected frame pathname.
  const expected = run.formOrigin;
  if (!expected?.domain) return run.status === 'running';
  if (parsed.hostname !== expected.domain) return false;
  const samePublication = smartRecruitersPublication(expected.domain, expected.pathname)
    && smartRecruitersPublication(parsed.hostname, parsed.pathname) === smartRecruitersPublication(expected.domain, expected.pathname);
  const expectedDocumentId = run.frame?.destination?.documentId;
  if (tab?.documentId && expectedDocumentId && tab.documentId !== expectedDocumentId
    && !samePublication && !(run.status === 'running' && run.lastAction === 'next')) return false;
  if (!expected.pathname || parsed.pathname === expected.pathname || samePublication) return true;
  // A user-approved Next/Continue click may update the URL before the new
  // content script reports navigation. Keep that transition authorized for
  // this session, then processPage replaces the frame identity.
  return run.status === 'running' && run.lastAction === 'next';
}

function smartRecruitersPublication(domain, pathname) {
  if (domain !== 'jobs.smartrecruiters.com') return '';
  const match = /^\/oneclick-ui\/company\/([^/]+)\/publication\/([^/]+)(?:\/|$)/i.exec(pathname || '');
  return match ? `${match[1].toLowerCase()}/${match[2].toLowerCase()}` : '';
}

function assertRunSiteAuthority(tabId, run) {
  if (run?.siteRevision != null && siteRevision(tabId) !== run.siteRevision) throw new Error(DISABLED_SITE_REASON);
}

function siteAuthority(tabId) {
  const revision = siteRevision(tabId);
  return () => {
    if (siteRevision(tabId) !== revision) throw new Error(DISABLED_SITE_REASON);
  };
}

async function assertTabFormActive(tabId, tabHint = null) {
  const state = await assertTabSiteEnabled(tabId, tabHint);
  const run = Number.isInteger(tabId) ? await getRun(tabId) : null;
  const tab = await tabForSite(tabId, tabHint && typeof tabHint === 'object' ? tabHint : null);
  if (!formSessionMatchesTab(run, tab)) throw new Error(INACTIVE_FORM_REASON);
  return state;
}

async function notifySiteState(tabId, enabled) {
  let frames = [{ frameId: 0 }];
  try { frames = await enumerateFrames(tabId); } catch { /* inaccessible tabs have no content listener to notify */ }
  await Promise.allSettled(frames.map(({ frameId }) => chrome.tabs.sendMessage(
    tabId,
    { type: 'JOB_APP_SITE_STATE_CHANGED', enabled },
    { frameId },
  )));
}

async function updateSiteDisabled(tabId, disabled) {
  const state = await siteStateForTab(tabId);
  if (!state.supported) throw new Error('Site controls are unavailable on this browser page.');
  const hostname = normalizeHostname(state.hostname);
  const disabledHostnames = normalizeHostnames(state.disabledHostnames);
  const next = disabled
    ? normalizeHostnames([...disabledHostnames, hostname])
    : disabledHostnames.filter((item) => item !== hostname);
  bumpSiteRevision(tabId);
  await chrome.storage.local.set({ [SITE_SETTINGS_KEY]: next });
  await invalidateInlineSessions(tabId);
  await removeRun(tabId);
  await notifySiteState(tabId, false);
  return siteStateReply({ ...state, disabled, disabledHostnames: next });
}

async function removeDisabledHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  if (!normalized) throw new Error('A valid hostname is required.');
  const current = await getDisabledHostnames();
  const next = current.filter((item) => item !== normalized);
  await chrome.storage.local.set({ [SITE_SETTINGS_KEY]: next });
  return next;
}

function requiredBoundedText(value, label, maxLength) {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  if (!value.trim()) throw new Error(`${label} cannot be empty`);
  if (value.length > maxLength) throw new Error(`${label} is too long`);
  return value;
}

async function getRuns() {
  const stored = await chrome.storage.session.get({ [RUN_STORAGE_KEY]: {} });
  return stored[RUN_STORAGE_KEY] || {};
}

async function getRun(tabId) {
  const runs = await getRuns();
  const run = runs[String(tabId)] || null;
  if (run?.siteRevision != null && !siteRevisions.has(tabId)) siteRevisions.set(tabId, run.siteRevision);
  if (run && ((run.status === 'running' && run.workerId !== WORKER_ID) || Object.values(run.aiOperations || {}).some(op => op.status === 'pending' && op.workerId !== WORKER_ID))) {
    for (const op of Object.values(run.aiOperations || {})) if (op.status === 'pending' && op.workerId !== WORKER_ID) op.status = 'interrupted';
    run.status = 'waiting_user'; run.progress = 'ready'; run.waitingFor = 'operation_interrupted'; run.nextAction = null;
    run.actionRequired = [...(run.actionRequired || []).filter(item => item.reasonCode !== 'operation_interrupted'), { reasonCode: 'operation_interrupted', reason: 'The previous operation was interrupted. Check the page or retry AI.' }];
    await saveRun(run);
  }
  return run;
}

async function saveRun(run) {
  if (run?.siteRevision != null && siteRevision(run.tabId) !== run.siteRevision) throw new Error(DISABLED_SITE_REASON);
  runWriteChain = runWriteChain.catch(() => {}).then(async () => {
    if (run?.siteRevision != null && siteRevision(run.tabId) !== run.siteRevision) throw new Error(DISABLED_SITE_REASON);
    const runs = await getRuns();
    if (run?.siteRevision != null && siteRevision(run.tabId) !== run.siteRevision) throw new Error(DISABLED_SITE_REASON);
    runs[String(run.tabId)] = { ...run, revision: (runs[String(run.tabId)]?.revision || 0) + 1, workerId: WORKER_ID, updatedAt: new Date().toISOString() };
    await chrome.storage.session.set({ [RUN_STORAGE_KEY]: runs });
    return runs[String(run.tabId)];
  });
  return runWriteChain;
}

async function removeRun(tabId) {
  const runs = await getRuns();
  delete runs[String(tabId)];
  await chrome.storage.session.set({ [RUN_STORAGE_KEY]: runs });
  await notifySiteState(tabId, false);
}

async function loadSeedData() {
  if (typeof chrome.runtime?.getURL !== 'function') throw new Error('The bundled datasource URL is unavailable');
  const response = await fetch(chrome.runtime.getURL('data/seed-data.json'));
  if (!response.ok) throw new Error(`The bundled datasource could not be loaded (${response.status})`);
  return response.json();
}

function loadSeedDataOnce() {
  if (!bundledSeedPromise) bundledSeedPromise = loadSeedData().catch((error) => {
    bundledSeedPromise = null;
    throw error;
  });
  return bundledSeedPromise;
}

async function initializeDatasource() {
  const stored = await chrome.storage.local.get({
    answerRecords: [],
    coverMessages: [],
    datasourceMeta: null,
    profile: null,
    learningInbox: [],
    learningUndo: null,
    pendingLearnedAnswers: [],
    answerSource: '',
    sheetUrl: '',
    lastSyncedAt: '',
  });
  const legacyRecords = Array.isArray(stored.pendingLearnedAnswers)
    ? stored.pendingLearnedAnswers
    : [];
  let current = createDatasourceState({
    ...stored,
    profile: stored.profile || {},
    answerRecords: mergeAnswerRecords(stored.answerRecords, legacyRecords),
    datasourceMeta: stored.datasourceMeta || (legacyRecords.length ? {
      schemaVersion: 1,
      legacyMigrationCount: legacyRecords.length,
      legacyMigratedAt: new Date().toISOString(),
      legacyAnswerSource: String(stored.answerSource || ''),
      legacySheetUrl: String(stored.sheetUrl || ''),
      legacyLastSyncedAt: String(stored.lastSyncedAt || ''),
    } : null),
  });
  if (shouldSeedDatasource(current)) {
    const seed = await loadSeedDataOnce();
    const seeded = seedDatasource(seed);
    await chrome.storage.local.set({
      answerRecords: seeded.answerRecords,
      coverMessages: seeded.coverMessages,
      datasourceMeta: seeded.datasourceMeta,
      profile: seeded.profile,
    });
    return seeded;
  }
  const seed = current.datasourceMeta?.seedId === BUNDLED_SEED_ID && !current.datasourceMeta?.bundledPublicLinksMigrationAt
    ? await loadSeedDataOnce()
    : null;
  const migrated = confirmBundledPublicLinks(current, seed);
  const migrationChanged = migrated !== current;
  if (migrationChanged) current = migrated;
  if (migrationChanged || legacyRecords.length || !stored.datasourceMeta || !stored.profile) {
    current.datasourceMeta ||= { schemaVersion: current.schemaVersion, initializedAt: new Date().toISOString() };
    await chrome.storage.local.set({
      answerRecords: current.answerRecords,
      coverMessages: current.coverMessages,
      datasourceMeta: current.datasourceMeta,
      profile: current.profile,
      learningUndo: current.learningUndo,
    });
  }
  return current;
}

async function getDatasource() {
  if (!datasourceInitPromise) datasourceInitPromise = initializeDatasource().finally(() => { datasourceInitPromise = null; });
  return datasourceInitPromise;
}

async function saveDatasource(state) {
  await chrome.storage.local.set({
    answerRecords: state.answerRecords,
    coverMessages: state.coverMessages,
    datasourceMeta: state.datasourceMeta,
    profile: state.profile,
    learningInbox: state.learningInbox || [],
    learningUndo: state.learningUndo || null,
  });
  return state;
}

async function queueLearningReview(records = [], sessionId = '') {
  const current = await getDatasource();
  const inbox = Array.isArray(current.learningInbox) ? current.learningInbox : [];
  const candidates = buildLearningCandidates(records).filter(candidate => !current.answerRecords.some(record => record.key === candidate.id) && !inbox.some(item => item.candidate?.id === candidate.id));
  if (!candidates.length) return { queued: 0, error: '' };
  const settings = await getSettings();
  const apiKey = await getApiKey(settings.aiProvider);
  let proposals;
  let error = '';
  let traceContext = null;
  try {
    traceContext = createPhoenixTrace(sessionId, { 'phoenix.action': 'learning_review', 'learning.candidate_count': candidates.length });
    await persistPhoenixAction(traceContext, 'learning_review', sessionId, {'learning.candidate_count': candidates.length});
    void tracePhoenixEvent('learning_review', {'learning.candidate_count': candidates.length}, sessionId, {traceContext, root: true, defer: true, input: candidates});
    proposals = apiKey ? await callLearningReviewer({ apiKey, candidates }, { provider: settings.aiProvider, model: settings.aiModel, sessionId, traceContext }) : candidates.map(candidate => ({ candidateId: candidate.id, outcome: 'needs_user_label', canonicalKey: '', displayLabel: '', intent: 'other', valueKind: candidate.valueShape, aliases: [], topicTags: [], scope: candidate.scope, reusePolicy: 'never', confidence: 'low', classifier: { model: '', promptVersion: 'learning-review-v1', classifiedAt: new Date().toISOString() } }));
    void tracePhoenixEvent('learning_review_result', {'learning.candidate_count': candidates.length, 'learning.proposal_count': proposals.length}, sessionId, {traceContext, output: proposals});
  } catch (caught) {
    error = caught.message;
    if (traceContext) void tracePhoenixEvent('learning_review_result', {'learning.validation_error': error}, sessionId, {traceContext, statusCode: 'ERROR', statusMessage: error, output: {retained: false}});
    proposals = candidates.map(candidate => ({ candidateId: candidate.id, outcome: 'needs_user_label', canonicalKey: '', displayLabel: '', intent: 'other', valueKind: candidate.valueShape, aliases: [], topicTags: [], scope: candidate.scope, reusePolicy: 'never', confidence: 'low', classifier: { model: settings.aiModel, promptVersion: 'learning-review-v1', classifiedAt: new Date().toISOString() } }));
  }
  const now = new Date().toISOString();
  const byKey = new Map(records.map(record => [record.key, record]));
  const learningInbox = [...inbox, ...proposals.map(proposal => ({ id: `learning:${proposal.candidateId}:${Date.now()}`, status: 'pending', candidate: candidates.find(candidate => candidate.id === proposal.candidateId), record: byKey.get(proposal.candidateId), proposal, error, createdAt: now }))];
  await saveDatasource({ ...current, learningInbox, datasourceMeta: { ...(current.datasourceMeta || {}), schemaVersion: current.schemaVersion, updatedAt: now } });
  if (traceContext) {
    void tracePhoenixEvent('learning_review', {'learning.candidate_count': candidates.length, 'learning.proposal_count': proposals.length}, sessionId, {traceContext, root: true, statusCode: error ? 'ERROR' : 'OK', statusMessage: error, output: {retained: true, queued: proposals.length, error}});
    void clearPhoenixAction(traceContext);
  }
  return { queued: proposals.length, error };
}

function scopeEmploymentRecords(records = [], profile = {}) {
  const employment = profile.employment || [];
  const confirmed = employment[0];
  if (!confirmed) return records;
  const matchingSections = new Set(records
    .filter((record) => record.entityType === 'employment'
      && /company|employer|organization/.test(String(record.question || record.key || '').toLowerCase())
      && String(record.answer || '').trim().toLowerCase() === confirmed.company.toLowerCase())
    .map((record) => record.entityId));
  return records.map((record) => matchingSections.has(record.entityId)
    ? { ...record, employmentId: confirmed.id }
    : record);
}

function reuseScopeFor(record = {}) {
  if (record.employmentId) return 'employment';
  if (record.entityId || record.entityType) return 'entity';
  const text = `${record.question || ''} ${record.type || ''}`.toLowerCase();
  return /why|motivation|cover letter|additional information|textarea/.test(text) ? 'application' : 'global';
}

function saveStats(before = [], after = [], records = []) {
  let persisted = 0;
  let updated = 0;
  let unchanged = 0;
  let unresolved = 0;
  for (const raw of records) {
    const record = normalizeAnswerRecord(raw);
    if (!record.answer || raw.completed === false) { unresolved += 1; continue; }
    const previous = before.find((item) => item.key === record.key);
    const next = after.find((item) => item.key === record.key);
    if (!next) { unresolved += 1; continue; }
    if (!previous) persisted += 1;
    else if (previous.answer !== next.answer) updated += 1;
    else unchanged += 1;
  }
  return { persisted, updated, unchanged, unresolved, savedCount: persisted + updated };
}

async function persistLearnedRecords(records = [], run = null, { promote = false, auto = false, assertAuthority = null } = {}) {
  assertAuthority?.();
  const now = new Date().toISOString();
  datasourceWriteChain = datasourceWriteChain.catch(() => {}).then(async () => {
    assertAuthority?.();
    const current = await getDatasource();
    assertAuthority?.();
    let learned = records;
    let changedRecords = null;
    if (run) {
      const stored = await chrome.storage.local.get({ applicationDrafts: {} });
      const drafts = stored.applicationDrafts || {};
      const id = `${run.tabId}:${run.startedAt}`;
      const previous = drafts[id]?.records || [];
      learned = records.map((record) => {
        const baseline = previous.find((item) => item.key === normalizeAnswerRecord(record).key);
        if (!record.userEdited && baseline?.completed === false && baseline.answer === record.answer) return { ...record, completed: false };
        return !record.userEdited && baseline?.provenance === 'autofill' && baseline.answer === record.answer
          ? { ...record, provenance: 'autofill' } : record;
      });
      changedRecords = learned.filter((record) => {
        const baseline = previous.find((item) => item.key === normalizeAnswerRecord(record).key);
        return !baseline || baseline.answer !== record.answer || baseline.completed !== record.completed || baseline.provenance !== record.provenance;
      });
      drafts[id] = { applicationId: run.startedAt, tabId: run.tabId, frame: run.frame, updatedAt: now, records: upsertAnswerRecords(previous, learned, now) };
      assertAuthority?.();
      await chrome.storage.local.set({ applicationDrafts: drafts });
    }
    const scoped = scopeEmploymentRecords(promote ? learned : (changedRecords || learned), current.profile);
    // A blur/change checkpoint may promote only clear, user-entered facts.
    // Sensitive facts still require an explicit Save/review action.
    const promotable = scoped
      .filter((record) => record.provenance !== 'autofill' && record.completed !== false)
      .filter((record) => !auto || (inferSensitivity(record.question, record.key) === 'safe' && record.sensitivity === 'safe'))
      .map((record) => ({ ...record, provenance: 'user', userEdited: true, reuseScope: record.reuseScope || reuseScopeFor(record) }));
    const answerRecords = promote
      ? mergeLearnedAnswers(current.answerRecords, promotable, now, { confirm: !auto })
      : current.answerRecords;
    assertAuthority?.();
    const state = await saveDatasource({
      ...current,
      answerRecords,
      learningUndo: auto && promotable.length && JSON.stringify(answerRecords) !== JSON.stringify(current.answerRecords)
        ? { answerRecords: current.answerRecords, savedAt: now, applicationId: run?.startedAt || '' } : current.learningUndo,
      datasourceMeta: { ...(current.datasourceMeta || {}), schemaVersion: current.schemaVersion, updatedAt: now },
    });
    return { state, stats: saveStats(current.answerRecords, answerRecords, promote ? promotable : scoped) };
  });
  return datasourceWriteChain;
}

async function undoLastAutoLearn() {
  datasourceWriteChain = datasourceWriteChain.catch(() => {}).then(async () => {
    const current = await getDatasource();
    if (!Array.isArray(current.learningUndo?.answerRecords)) throw new Error('There is no recent automatic save to undo.');
    const state = await saveDatasource({
      ...current,
      answerRecords: current.learningUndo.answerRecords,
      learningUndo: null,
      datasourceMeta: { ...(current.datasourceMeta || {}), schemaVersion: current.schemaVersion, updatedAt: new Date().toISOString() },
    });
    return { answerCount: state.answerRecords.length, learningUndo: null };
  });
  return datasourceWriteChain;
}

async function getRecords({ includeProfile = false } = {}) {
  const state = await getDatasource();
  return [...state.answerRecords, ...(includeProfile ? profileEvidenceRecords(state.profile) : [])]
    .filter((record) => record.confirmationState !== 'pending' && (!record.alternatives?.length || record.confirmationState === 'confirmed'));
}

async function draftEvidenceRecords() {
  const { applicationDrafts } = await chrome.storage.local.get({ applicationDrafts: {} });
  return Object.entries(applicationDrafts || {}).flatMap(([application, draft]) => (draft.records || [])
    .filter(record => record.provenance === 'user' && record.completed !== false && record.confirmationState !== 'pending' && !record.alternatives?.length)
    .map(record => ({ ...record, key: `draft:${application}:${record.key}`, draft: true, confirmationState: 'confirmed' })));
}

async function getCoverMessages() {
  return (await getDatasource()).coverMessages;
}

async function getSettings() {
  const stored = await chrome.storage.local.get({ autoAdvancePages: false, includeFormScreenshot: true, voteAutofillEnabled: true, aiProvider: '', aiModel: '', openaiModel: '', openaiApiKey: '', fireworksApiKey: '', typesafeApiKey: '', typesafeEnabled: null, typesafeAutofillEnabled: true, typesafeAutofillSensitive: true, typesafeNoMatchTop: true });
  const aiProvider = stored.aiProvider === 'openai' || stored.aiProvider === 'fireworks'
    ? stored.aiProvider
    : (String(stored.openaiApiKey || '').trim() ? 'openai' : DEFAULT_PROVIDER);
  const fallbackModel = aiProvider === 'fireworks' ? DEFAULT_FIREWORKS_MODEL : DEFAULT_OPENAI_MODEL;
  const aiModel = String(stored.aiModel || (aiProvider === 'openai' ? stored.openaiModel : '') || fallbackModel).trim() || fallbackModel;
  return {
    autoAdvancePages: Boolean(stored.autoAdvancePages),
    includeFormScreenshot: stored.includeFormScreenshot !== false,
    voteAutofillEnabled: stored.voteAutofillEnabled !== false,
    aiProvider,
    aiModel,
    openaiModel: aiModel,
    typesafeEnabled: stored.typesafeEnabled === null ? Boolean(stored.typesafeApiKey) : Boolean(stored.typesafeEnabled),
    typesafeAutofillEnabled: stored.typesafeAutofillEnabled !== false,
    typesafeAutofillSensitive: stored.typesafeAutofillSensitive !== false,
    typesafeNoMatchTop: stored.typesafeNoMatchTop !== false,
  };
}

async function datasourceSummary() {
  const state = await getDatasource();
  const learnedChanges = state.answerRecords
    .filter((record) => !record.changeReviewedAt && (record.history?.length || record.alternatives?.length || record.provenance === 'user' || record.confirmationState === 'pending'))
    .map((record) => ({
      key: record.key,
      question: record.question,
      answer: record.answer,
      history: record.history || [],
      alternatives: record.alternatives || [],
      entityId: record.entityId || '',
      context: record.context || '',
      confirmedAt: record.confirmedAt || null,
      pendingAnswer: record.pendingAnswer || '',
      confirmationState: record.confirmationState || 'legacy',
    }));
  return {
    schemaVersion: state.schemaVersion,
    answerCount: state.answerRecords.length,
    coverMessageCount: state.coverMessages.length,
    learningInbox: state.learningInbox || [],
    undoAvailable: Boolean(state.learningUndo),
    initializedAt: state.datasourceMeta?.initializedAt || null,
    seededAt: state.datasourceMeta?.seededAt || null,
    learnedChanges,
    profile: state.profile,
  };
}

async function resolveLearningInbox(id, action) {
  const state = await getDatasource();
  const item = state.learningInbox.find(entry => entry.id === id && entry.status === 'pending');
  if (!item) throw new Error('The learning proposal is no longer available.');
  let answerRecords = state.answerRecords;
  if (action === 'approve') {
    if (item.proposal?.outcome !== 'propose' || !item.record?.answer) throw new Error('Add a clear label before approving this proposal.');
    answerRecords = upsertAnswerRecords(state.answerRecords, [{ ...item.record, key: item.proposal.canonicalKey, question: item.proposal.displayLabel, aliases: [item.record.question, ...(item.proposal.aliases || [])], concept: item.proposal.canonicalKey, semantic: item.proposal, confirmationState: 'confirmed', confirmedAt: new Date().toISOString() }]);
  }
  await saveDatasource({ ...state, answerRecords, learningInbox: state.learningInbox.filter(entry => entry.id !== id), datasourceMeta: { ...(state.datasourceMeta || {}), updatedAt: new Date().toISOString() } });
  return datasourceSummary();
}

async function correctDatasourceRecord(key, answer) {
  const normalizedAnswer = String(answer ?? '').trim();
  if (!key || !normalizedAnswer) throw new Error('A correction must include a value.');
  const now = new Date().toISOString();
  datasourceWriteChain = datasourceWriteChain.catch(() => {}).then(async () => {
    const current = await getDatasource();
    const existing = current.answerRecords.find((record) => record.key === key);
    if (!existing) throw new Error('The learned answer no longer exists.');
    const answerRecords = upsertAnswerRecords(current.answerRecords, [{
      ...existing,
      answer: normalizedAnswer,
      provenance: 'user',
      confirmationState: 'confirmed',
      pendingAnswer: '',
      changeReviewedAt: now,
      confirmedAt: now,
      updatedAt: now,
    }], now);
    return saveDatasource({
      ...current,
      answerRecords,
      datasourceMeta: { ...(current.datasourceMeta || {}), schemaVersion: current.schemaVersion, updatedAt: now },
    });
  });
  const state = await datasourceWriteChain;
  return {
    schemaVersion: state.schemaVersion,
    answerCount: state.answerRecords.length,
    coverMessageCount: state.coverMessages.length,
    learnedChanges: state.answerRecords
      .filter((record) => !record.changeReviewedAt && (record.history?.length || record.alternatives?.length || record.provenance === 'user' || record.confirmationState === 'pending'))
      .map((record) => ({
        key: record.key,
        question: record.question,
        answer: record.answer,
        history: record.history || [],
        alternatives: record.alternatives || [],
        entityId: record.entityId || '',
        context: record.context || '',
        confirmedAt: record.confirmedAt || null,
        pendingAnswer: record.pendingAnswer || '',
        confirmationState: record.confirmationState || 'legacy',
      })),
  };
}

async function dismissDatasourceChange(key) {
  if (!key) throw new Error('A learned change key is required.');
  datasourceWriteChain = datasourceWriteChain.catch(() => {}).then(async () => {
    const current = await getDatasource();
    if (!current.answerRecords.some((record) => record.key === key)) throw new Error('The learned answer no longer exists.');
    const now = new Date().toISOString();
    return saveDatasource({
      ...current,
      answerRecords: current.answerRecords.map((record) => record.key === key ? { ...record, changeReviewedAt: now } : record),
      datasourceMeta: { ...(current.datasourceMeta || {}), schemaVersion: current.schemaVersion, updatedAt: now },
    });
  });
  await datasourceWriteChain;
  return datasourceSummary();
}

async function updateDatasourceProfile(profile) {
  datasourceWriteChain = datasourceWriteChain.catch(() => {}).then(async () => {
    const current = await getDatasource();
    const state = createDatasourceState({ ...current, profile, datasourceMeta: {
      ...(current.datasourceMeta || {}), schemaVersion: current.schemaVersion, updatedAt: new Date().toISOString(),
    } });
    return saveDatasource(state);
  });
  await datasourceWriteChain;
  return datasourceSummary();
}

async function importDatasourceBackup(backup) {
  const imported = parseDatasourceBackup(backup);
  datasourceWriteChain = datasourceWriteChain.catch(() => {}).then(async () => {
    const merged = mergeDatasource(await getDatasource(), imported);
    await saveDatasource(merged);
    return merged;
  });
  return datasourceWriteChain;
}

async function getApiKey(provider = null) {
  const selectedProvider = provider || (await getSettings()).aiProvider;
  const stored = await chrome.storage.local.get({ openaiApiKey: '', fireworksApiKey: '' });
  return String(stored[selectedProvider === 'fireworks' ? 'fireworksApiKey' : 'openaiApiKey'] || '').trim();
}

function missingProviderKeyMessage(provider) {
  return `Add ${provider === 'fireworks' ? 'a Fireworks' : 'an OpenAI'} API key in Settings to use AI answers.`;
}

async function getTypeSafeApiKey() {
  return String((await chrome.storage.local.get({ typesafeApiKey: '' })).typesafeApiKey || '').trim();
}

async function enumerateFrames(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => ({
      title: document.title || '',
      pathname: document.location?.pathname || '',
    }),
  });
  const frames = (results || [])
    .map((item) => ({
      frameId: Number.isInteger(item?.frameId) ? item.frameId : 0,
      title: String(item?.result?.title || ''),
      pathname: String(item?.result?.pathname || ''),
    }))
    .filter((frame, index, all) => all.findIndex((candidate) => candidate.frameId === frame.frameId) === index);
  return frames.length ? frames : [{ frameId: 0, title: '', pathname: '' }];
}

async function ensureContentScripts(tabId, frameIds, assertAuthority) {
  if (!frameIds.length) return;
  await assertTabSiteEnabled(tabId);
  assertAuthority?.();
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds },
      files: ['dist/content.js'],
    });
  } catch {
    await Promise.allSettled(frameIds.map((frameId) => chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ['dist/content.js'],
    })));
  }
}

async function sendToFrame(tabId, frameId, message, assertAuthority) {
  const targetFrameId = Number.isInteger(frameId) ? frameId : 0;
  assertAuthority?.();
  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, message, { frameId: targetFrameId });
  } catch {
    // Never replay a write after losing its original receiver: it may already have run.
    if (['JOB_APP_APPLY', 'JOB_APP_CLICK_NEXT', 'JOB_APP_FOCUS'].includes(message.type)) throw new Error('The selected form is no longer available. Retry the scan.');
    assertAuthority?.();
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [targetFrameId] },
      files: ['dist/content.js'],
    });
    assertAuthority?.();
    response = await chrome.tabs.sendMessage(tabId, message, { frameId: targetFrameId });
  }
  assertAuthority?.();
  return response;
}

function frameInspectionText(context, inspection) {
  return [
    context.title,
    inspection?.page?.title,
    inspection?.applicationLabel,
    ...(inspection?.actions || []).map((action) => action.label || ''),
  ].join(' ');
}

function scoreApplicationFrame(context, inspection, selectedDestination = null) {
  const fields = inspection?.fields || [];
  const actions = inspection?.actions || [];
  const applicationHint = APPLICATION_TITLE_PATTERN.test(frameInspectionText(context, inspection));
  const fieldText = fields.map(field => [field.label, field.autocomplete, field.canonicalKey].filter(Boolean).join(' '));
  const fieldTextJoined = fieldText.join(' ');
  const applicationField = fieldText.some(text => /\b(?:full[ _-]?name|first[ _-]?name|last[ _-]?name|given[ _-]?name|family[ _-]?name|resume|cover[ _-]?letter|work[ _-]?authorization|employment|salary|experience|education|notice\s+period|current\s+location)\b/i.test(text));
  const concepts = new Set();
  if (/\b(?:full[ _-]?name|first[ _-]?name|last[ _-]?name|email|phone|mobile|whatsapp)\b/i.test(fieldTextJoined)) concepts.add('identity');
  if (/\b(?:resume|cover[ _-]?letter|work[ _-]?authorization|employment|salary|compensation|experience|education|notice\s+period|current\s+location|work\s+from\s+office)\b/i.test(fieldTextJoined)) concepts.add('application');
  if (/\b(?:salary|compensation)\b/i.test(fieldTextJoined)) concepts.add('compensation');
  if (/\b(?:experience|education|employment)\b/i.test(fieldTextJoined)) concepts.add('history');
  if (/\b(?:location|notice\s+period|work\s+from\s+office)\b/i.test(fieldTextJoined)) concepts.add('availability');
  const applicationCluster = fields.length >= 3 && concepts.has('identity') && concepts.has('application') && concepts.size >= 3;
  const utilityHint = UTILITY_FRAME_PATTERN.test(fieldText.join(' ')) && !applicationField;
  const screening = smartRecruitersPublication(inspection?.page?.domain, context.pathname)
    && /\/screening(?:\/|$)/i.test(context.pathname)
    && fields.length > 0 && concepts.has('application');
  const applicationActions = actions.some(action => action.kind === 'next'
    || (action.kind === 'submit' && (applicationField || applicationCluster || /\b(?:application|apply)\b/i.test(action.label || ''))));
  const explicitSelection = selectedDestination && context.frameId === selectedDestination.frameId
    && inspection.destination?.documentId === selectedDestination.documentId && inspection.destination?.regionId === selectedDestination.regionId;
  const ready = !inspection.discovery || (inspection.discovery.code === 'ready' && Boolean(inspection.destination?.regionId));
  const eligible = ready && fields.length > 0 && (explicitSelection || (!utilityHint
    && (applicationActions || applicationCluster || (applicationHint && fields.length >= 2) || screening)));
  return {eligible};
}

function interpretationSignature(tabId, inspected, settings) {
  return JSON.stringify({
    tabId, provider: settings.aiProvider, model: settings.aiModel, image: settings.includeFormScreenshot,
    frames: inspected.filter(item => item.inspection).map(item => ({
      frameId: item.frameId, destination: item.inspection.destination,
      fields: item.inspection.fields.map(field => [field.handle, field.label, field.placeholder, field.type, field.required, field.options]),
      actions: item.inspection.actions.map(action => [action.handle, action.label, action.type]),
    })),
  });
}

async function formScreenshot(tabId, inspected, enabled) {
  if (!enabled || typeof chrome.tabs.captureVisibleTab !== 'function') return null;
  const top = inspected.find(item => item.frameId === 0)?.inspection?.visualContext;
  if (!top?.regions?.length) return null;
  try {
    const before = await chrome.tabs.get(tabId);
    if (!before?.active || !Number.isInteger(before.windowId)) return null;
    const dataUrl = await chrome.tabs.captureVisibleTab(before.windowId, {format: 'png'});
    const after = await chrome.tabs.get(tabId);
    if (!after?.active || after.windowId !== before.windowId || after.url !== before.url) return null;
    return await prepareFormScreenshot({dataUrl, ...top});
  } catch { return null; }
}

async function enrichAccessibilityInspection(tabId, inspection) {
  const accessibility = await browserController.observe(tabId);
  return accessibility.ok ? mergeAccessibilityInspection(inspection, accessibility.controls.filter(control => !control.sessionId)) : inspection;
}

function interpretInspection(inspection, interpretation) {
  const fieldMeanings = new Map(interpretation.fields.map(field => [field.handle, field]));
  const actionRoles = new Map(interpretation.actions.map(action => [action.handle, action.role]));
  return {
    ...inspection,
    fields: inspection.fields.map(field => {
      const meaning = fieldMeanings.get(field.handle);
      return meaning ? {...field, label: meaning.question || field.label, labelSource: 'ai-interpretation', labelConfidence: 'high',
        canonicalKey: meaning.meaning || field.canonicalKey, required: Boolean(field.required || meaning.required)} : field;
    }),
    actions: inspection.actions.map(action => {
      const role = actionRoles.get(action.handle);
      return role ? {...action, kind: role === 'next' ? 'next' : role === 'final_submit' ? 'submit' : 'other'} : action;
    }),
    interpretation: {mode: interpretation.contextMode, reason: interpretation.reason},
    formInterpretation: interpretation,
  };
}

function applyFormInterpretation(item, interpretation) {
  const inspection = interpretInspection(item.inspection, interpretation);
  return {...item, inspection, ...scoreApplicationFrame(item, inspection)};
}

async function interpretApplicationFrames(tabId, inspected, sessionId = '') {
  const frames = inspected.filter(item => item.inspection?.fields?.length);
  if (!frames.length) return null;
  const traceContext = createPhoenixTrace(sessionId, {'phoenix.action': 'form_interpretation', 'form.frame_count': frames.length});
  await persistPhoenixAction(traceContext, 'form_interpretation', sessionId, {'form.frame_count': frames.length});
  void tracePhoenixEvent('form_interpretation', {'form.frame_count': frames.length}, sessionId, {traceContext, root: true, defer: true, input: frames});
  const finishTrace = (output, statusCode = 'OK', statusMessage = '') => {
    void tracePhoenixEvent('form_interpretation', {'form.frame_count': frames.length, 'ai.retained': output?.retained !== false}, sessionId, {traceContext, root: true, statusCode, statusMessage, output});
    void clearPhoenixAction(traceContext);
  };
  const settings = await getSettings();
  const apiKey = await getApiKey(settings.aiProvider);
  if (!apiKey) { finishTrace({retained: false, reason: 'missing_provider_key'}); return null; }
  const signature = interpretationSignature(tabId, frames, settings);
  let interpretation = formInterpretationCache.get(signature);
  if (!interpretation) {
    const screenshot = await formScreenshot(tabId, frames, settings.includeFormScreenshot);
    try {
      interpretation = await callFormInterpreter({apiKey, snapshot: {frames}, screenshot}, {provider: settings.aiProvider, model: settings.aiModel, sessionId, traceContext});
    } catch (error) {
      void tracePhoenixEvent('form_interpretation_result', {'form.validation_error': error.message}, sessionId, {traceContext, statusCode: 'ERROR', statusMessage: error.message, output: {retained: false}});
      finishTrace({retained: false, reason: error.message}, 'ERROR', error.message);
      throw error;
    }
    void tracePhoenixEvent('form_interpretation_result', {'form.status': interpretation.status}, sessionId, {traceContext, output: interpretation});
    if (interpretation.status === 'ready') formInterpretationCache.set(signature, interpretation);
  }
  if (interpretation.status !== 'ready') { finishTrace({retained: false, reason: 'not_ready', status: interpretation.status}); return null; }
  const currentSettings = await getSettings();
  if (currentSettings.aiProvider !== settings.aiProvider || currentSettings.aiModel !== settings.aiModel
    || currentSettings.includeFormScreenshot !== settings.includeFormScreenshot) { finishTrace({retained: false, reason: 'settings_changed'}); return null; }
  let selected = frames.find(item => item.frameId === interpretation.frameId);
  if (!selected) { finishTrace({retained: false, reason: 'frame_changed'}); return null; }
  const refreshed = await sendToFrame(tabId, selected.frameId, {type: 'JOB_APP_INSPECT'});
  if (!refreshed?.ok || !refreshed.inspection) { finishTrace({retained: false, reason: 'inspection_failed'}); return null; }
  const freshItem = {...selected, inspection: refreshed.inspection};
  if (interpretationSignature(tabId, [selected], settings) !== interpretationSignature(tabId, [freshItem], settings)) { finishTrace({retained: false, reason: 'page_changed'}); return null; }
  selected = freshItem;
  const interpreted = selected ? applyFormInterpretation(selected, interpretation) : null;
  if (!interpreted?.eligible) { finishTrace({retained: false, reason: 'ineligible'}); return null; }
  finishTrace({retained: true, status: interpretation.status});
  return interpreted;
}

function discoveryFailure(errorCode, diagnostics = []) {
  return { errorCode, reason: DISCOVERY_REASONS[errorCode] || DISCOVERY_REASONS.inspection_error, diagnostics };
}

async function cancelFormSelection(tabId) {
  const request = formSelections.get(tabId);
  formSelections.delete(tabId);
  if (request) await Promise.allSettled(request.frames.map(frame => chrome.tabs.sendMessage(tabId, {type: 'JOB_APP_CANCEL_FORM_SELECTION'}, {frameId: frame.frameId})));
}

async function requestFormSelection(tabId, {debug = false} = {}) {
  await cancelFormSelection(tabId);
  const run = debug ? null : await getRun(tabId);
  if (!debug && (!run || processingTabs.has(tabId))) throw new Error('Check the page before selecting a form.');
  const contexts = await enumerateFrames(tabId);
  const request = {token: crypto.randomUUID(), expiresAt: Date.now() + FORM_SELECTION_TTL_MS, applicationId: run?.startedAt, debug, frames: []};
  formSelections.set(tabId, request);
  await Promise.allSettled(contexts.map(async context => {
    const response = await sendToFrame(tabId, context.frameId, {type: 'JOB_APP_SELECT_FORM', token: request.token, expiresAt: request.expiresAt, debug});
    if (response?.ok && response.destination?.documentId) request.frames.push({frameId: context.frameId, documentId: response.destination.documentId});
  }));
  if (!request.frames.length) {
    formSelections.delete(tabId);
    if (debug) throw new Error('Could not select a form on this page. Reload it and try again.');
    return {ok: false, run: await saveRun(pauseForFrame(run, discoveryFailure('script_unavailable')))};
  }
  if (debug) return {ok: true, selectionRequired: true};
  run.waitingFor = 'selecting_form';
  run.progress = null;
  run.actionRequired = [{code: 'selecting_form', category: 'pause', reason: 'Click a field in the form you want to fill. Selection expires in 60 seconds.'}];
  return {ok: true, run: await saveRun(run)};
}

async function acceptFormSelection(message, sender) {
  const tabId = sender?.tab?.id;
  const request = formSelections.get(tabId);
  if (sender?.id !== chrome.runtime.id || !request || request.token !== message.token || Date.now() > request.expiresAt
    || !request.frames.some(frame => frame.frameId === sender.frameId && frame.documentId === message.destination?.documentId)) throw new Error('Form selection expired. Click Select form again.');
  if (request.debug) {
    await assertTabSiteEnabled(tabId, sender.tab);
    const settings = await chrome.storage.local.get({developerMode: false});
    if (settings.developerMode !== true) throw new Error('Enable Developer mode to capture debug cases.');
    await cancelFormSelection(tabId);
    if (!message.fieldOnly && message.destination?.regionId) {
      debugSelections.set(tabId, {frameId: sender.frameId, destination: message.destination, expiresAt: Date.now() + 5 * 60_000});
      return {ok: true, debugSelection: true};
    }
    return {ok: false, error: 'Select a field inside one application form.'};
  }
  await assertTabFormActive(tabId, sender);
  const run = await getRun(tabId);
  if (!run || run.startedAt !== request.applicationId || processingTabs.has(tabId)) throw new Error('The application changed. Select the form again.');
  await cancelFormSelection(tabId);
  if (message.fieldOnly || !message.destination?.regionId) {
    pauseForFrame(run, discoveryFailure('no_supported_controls'));
    run.waitingFor = 'field_only';
    run.actionRequired = [{code: 'field_only', category: 'pause', reason: 'This field could not be scoped to one form. Use the suggestions beside the field, or complete it manually.'}];
    return {ok: true, run: await saveRun(run)};
  }
  run.status = 'running';
  run.selectedDestination = {...message.destination, frameId: sender.frameId};
  await saveRun(run);
  return {ok: true, run: await processPage(tabId, {autoAdvance: false, selectedDestination: {...message.destination, frameId: sender.frameId}})};
}

async function discoverApplicationFrame(tabId, assertAuthority = null, selectedDestination = null, sessionId = '') {
  await assertTabSiteEnabled(tabId);
  assertAuthority?.();
  let contexts;
  try { contexts = await enumerateFrames(tabId); }
  catch { return discoveryFailure('script_unavailable'); }
  await ensureContentScripts(tabId, contexts.map(context => context.frameId), assertAuthority);
  const inspected = await Promise.all(contexts.map(async context => {
    try {
      const response = await sendToFrame(tabId, context.frameId, { type: 'JOB_APP_INSPECT' }, assertAuthority);
      if (!response?.ok || !response.inspection) return {...context, code: response?.code || 'inspection_error'};
      const inspection = context.frameId === 0 ? await enrichAccessibilityInspection(tabId, response.inspection) : response.inspection;
      return {...context, inspection, ...scoreApplicationFrame(context, inspection, selectedDestination), version: response.version};
    } catch { return {...context, code: 'script_unavailable'}; }
  }));
  // Only counts, outcomes and timings are persisted. Never store page text or answers here.
  const diagnostics = inspected.map(item => ({frameId: item.frameId, code: item.code || item.inspection?.discovery?.code || (item.eligible ? 'ready' : 'no_supported_controls'),
    controlCount: item.inspection?.discovery?.controlCount ?? item.inspection?.fields?.length ?? 0,
    regionCount: item.inspection?.discovery?.regionCount ?? 0, shadowRootCount: item.inspection?.discovery?.shadowRootCount ?? 0,
    elapsedMs: item.inspection?.discovery?.elapsedMs ?? 0, version: item.version || null}));
  let candidates = inspected.filter(item => item.eligible);
  if (selectedDestination) {
    candidates = candidates.filter(item => item.frameId === selectedDestination.frameId
      && item.inspection?.destination?.documentId === selectedDestination.documentId
      && item.inspection?.destination?.regionId === selectedDestination.regionId);
    if (candidates.length !== 1) return discoveryFailure('destination_changed', diagnostics);
  } else if (candidates.length !== 1 || inspected.some(item => item.inspection?.discovery?.code === 'ambiguous_form')) {
    let interpreted = null;
    let interpretationError = null;
    try {
      interpreted = await interpretApplicationFrames(tabId, inspected, sessionId);
      if (interpreted) candidates = [interpreted];
    } catch (error) { interpretationError = error; }
    if (!interpreted && (candidates.length > 1 || inspected.some(item => item.inspection?.discovery?.code === 'ambiguous_form'))) return discoveryFailure('ambiguous_form', diagnostics);
    if (!interpreted && !candidates.length && /timed out/i.test(interpretationError?.message || '')) return discoveryFailure('form_interpretation_timeout', diagnostics);
  }
  if (!candidates.length) {
    const controls = diagnostics.filter(item => item.controlCount > 0);
    const relevant = controls.length ? controls : diagnostics;
    const code = ['loading_timeout', 'inspection_error', 'script_unavailable'].find(code => relevant.some(item => item.code === code)) || 'no_supported_controls';
    return discoveryFailure(code, diagnostics);
  }
  const selected = candidates[0];
  return {frameId: selected.frameId, context: {title: selected.title, pathname: selected.pathname}, inspection: selected.inspection, diagnostics};
}

async function captureDebugCase(tabId, tab) {
  const settings = await chrome.storage.local.get({developerMode: false});
  if (settings.developerMode !== true) throw new Error('Enable Developer mode in Settings to capture debug cases.');
  await assertTabSiteEnabled(tabId, tab);
  const contexts = await enumerateFrames(tabId);
  await ensureContentScripts(tabId, contexts.map(frame => frame.frameId));
  const inspected = await Promise.all(contexts.map(async context => {
    try {
      const response = await sendToFrame(tabId, context.frameId, {type: 'JOB_APP_DEBUG_INSPECT'});
      return response?.ok ? {...context, inspection: response.inspection} : {...context};
    } catch { return {...context}; }
  }));
  const run = await getRun(tabId);
  const currentRun = run && formSessionMatchesTab(run, tab) ? run : null;
  const selected = debugSelections.get(tabId);
  const selectedDestination = selected?.expiresAt > Date.now() ? selected : null;
  const matching = (frame, destination) => Boolean(destination?.documentId && destination?.regionId)
    && frame?.inspection?.destination?.documentId === destination.documentId
    && frame?.inspection?.destination?.regionId === destination?.regionId;
  const chosen = inspected.find(frame => selectedDestination && frame.frameId === selectedDestination.frameId && matching(frame, selectedDestination.destination))
    || inspected.find(frame => currentRun?.frame?.frameId === frame.frameId && matching(frame, currentRun.frame.destination));
  const candidates = inspected.filter(frame => frame.inspection?.destination?.regionId && scoreApplicationFrame(frame, frame.inspection).eligible);
  const target = chosen || (candidates.length === 1 ? candidates[0] : null);
  if (!target) return requestFormSelection(tabId, {debug: true});
  const response = await sendToFrame(tabId, target.frameId, {type: 'JOB_APP_DEBUG_SNAPSHOT', destination: target.inspection.destination});
  if (!response?.ok || !response.snapshot) throw new Error(response?.error || 'The selected form changed. Capture it again.');
  if ((await chrome.storage.local.get({developerMode: false})).developerMode !== true) throw new Error('Developer mode was disabled during capture.');
  const enteredValues = target.inspection.fields.flatMap(field => [field.rawValue, field.currentValue])
    .filter(value => typeof value === 'string' && value.trim().length >= 3);
  const scrub = value => enteredValues.reduce((text, answer) => text.replaceAll(answer, '[redacted]'), String(value || ''));
  return {ok: true, case: {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    site: {hostname: new URL(tab.url).hostname},
    frameId: target.frameId,
    pageNumber: currentRun?.frame?.frameId === target.frameId ? currentRun.pageNumber : null,
    sessionId: currentRun?.frame?.frameId === target.frameId ? `${tabId}:${currentRun.startedAt}` : null,
    outcomes: currentRun?.frame?.frameId === target.frameId ? {
      status: currentRun.status,
      actionRequired: (currentRun.actionRequired || []).map(item => ({code: item.code, category: item.category, reason: scrub(item.reason)})),
      reviewRequired: (currentRun.reviewRequired || []).map(item => ({label: scrub(item.label), reason: scrub(item.reason)})),
    } : null,
    snapshot: response.snapshot,
  }};
}

function selectedFrame(run) {
  if (!Number.isInteger(run?.frame?.frameId)) throw new Error('No application form frame is selected');
  return run.frame.frameId;
}

function updateSelectedFrame(tabId, run, discovery) {
  run.frame = {
    frameId: discovery.frameId,
    title: discovery.context.title,
    pathname: discovery.context.pathname,
    domain: discovery.inspection?.page?.domain || '',
    destination: discovery.inspection?.destination || null,
    interpretationMode: discovery.inspection?.interpretation?.mode || null,
  };
  if (discovery.inspection?.formInterpretation) activeFormInterpretations.set(tabId, discovery.inspection.formInterpretation);
  else activeFormInterpretations.delete(tabId);
  // Keep this alias for panel versions that predate the nested frame shape.
  run.frameId = discovery.frameId;
  run.discoveryDiagnostics = discovery.diagnostics || [];
}

function frameRoutingError(discovery, cause) {
  const error = new Error(discovery.reason);
  error.frameDiscovery = discovery;
  error.cause = cause;
  return error;
}

async function sendToApplicationFrame(tabId, run, message) {
  const frameId = selectedFrame(run);
  const assertAuthority = () => assertRunSiteAuthority(tabId, run);
  try {
    const response = await sendToFrame(tabId, frameId, {...message, destination: run.frame.destination}, assertAuthority);
    if (response?.code === 'destination_changed') throw frameRoutingError(discoveryFailure('destination_changed'));
    return response;
  } catch (error) {
    if (error.frameDiscovery) throw error;
    throw frameRoutingError(discoveryFailure('script_unavailable'), error);
  }
}

function pauseForFrame(run, discovery) {
  run.status = 'waiting_user';
  run.progress = null;
  run.selectedDestination = null;
  run.discoveryDiagnostics = discovery.diagnostics || [];
  run.frame = null;
  run.frameId = null;
  run.waitingFor = discovery.errorCode;
  run.waitingLabel = null;
  run.nextAction = null;
  run.actionRequired = [{
    reason: discovery.reason,
    code: discovery.errorCode,
    category: 'pause',
  }];
  run.optionalUnresolved = [];
  run.reviewRequired = [];
  run.suggestions = {};
  run.generatedSuggestions = {};
  run.semanticSearch = {};
  run.semanticAutofills = [];
  return run;
}

function nowRun(tabId, tab = null) {
  const startedAt = new Date().toISOString();
  let formOrigin = null;
  try {
    const url = new URL(tab?.url || '');
    formOrigin = {domain: url.hostname, pathname: url.pathname};
  } catch { /* the site guard rejects unsupported tabs before this point */ }
  return {
    tabId,
    siteRevision: siteRevision(tabId),
    status: 'running',
    pageNumber: 1,
    pages: [],
    answers: [],
    actionRequired: [],
    optionalUnresolved: [],
    reviewRequired: [],
    audit: [],
    frame: null,
    formOrigin,
    nextAction: null,
    waitingFor: null,
    waitingLabel: null,
    revision: 0,
    workerId: WORKER_ID,
    progress: 'checking_fields',
    aiOperations: {},
    employmentMappings: {},
    employmentChoices: [],
    llmError: null,
    generatedSuggestions: {},
    semanticSearch: {},
    semanticAutofills: [],
    jobContext: null,
    startedAt,
    // This mirrors startedAt so the panel can form a stable transient-draft
    // key without needing to know the worker's historical field name.
    applicationId: startedAt,
    updatedAt: startedAt,
  };
}

function fieldMap(fields) {
  return new Map(fields.map((field) => [field.id, field]));
}

function pageSignature(inspection, frame = null) {
  return JSON.stringify({
    frame: frame ? [frame.frameId, frame.title, frame.pathname] : [],
    destination: inspection.destination || null,
    page: [inspection.page?.title, inspection.page?.domain],
    fields: inspection.fields.map((field) => [field.id, field.label, field.type, field.options]),
    actions: inspection.actions.map((action) => [action.kind, action.label]),
  });
}

function choiceEvidenceNeedsPlanner(field, candidates = []) {
  if (!requiresVisibleChoiceMatch(field)) return false;
  return candidates.some((candidate) => !exactVisibleChoice(field, candidate.answer));
}

function reviewItems(fields, decisions, existing = [], appliedReviews = [], pageNumber = null) {
  const byId = fieldMap(fields);
  const items = [...existing];
  for (const decision of decisions) {
    const field = byId.get(decision.fieldId);
    if (!field || !field.currentValue) continue;
    if (decision.sensitivity !== 'safe'
      || decision.confidence !== 'high'
      || field.type === 'textarea'
      || String(field.currentValue).length > 240) {
      items.push({
        fieldId: field.id,
        label: field.label || field.id,
        ...(Number.isFinite(pageNumber) ? { pageNumber } : {}),
        formOrder: field.formOrder,
        value: field.currentValue,
        sensitivity: decision.sensitivity,
        confidence: decision.confidence,
        reason: decision.reason,
        formOrder: field.formOrder,
        pageNumber,
      });
    }
  }
  for (const item of appliedReviews) {
    const field = item.field || byId.get(item.fieldId);
    if (!field?.currentValue) continue;
    items.push({
      fieldId: field.id,
      label: field.label || field.id,
      ...(Number.isFinite(pageNumber) ? { pageNumber } : {}),
      formOrder: field.formOrder,
      value: field.currentValue,
      sensitivity: item.sensitivity,
      confidence: item.confidence,
      reason: item.reason,
      formOrder: field.formOrder,
      pageNumber,
    });
  }
  return [...new Map(items.map((item) => [item.fieldId, item])).values()];
}

function auditItems(records, pages = []) {
  const pageRecords = pages.flatMap((page) => (page.values || []).map((record, pageOrder) => ({
    ...record,
    pageNumber: page.pageNumber,
    pageOrder,
  })));
  const pageKeys = new Set(pageRecords.map((record) => record.key));
  const unrepresentedRecords = records.filter((record) => !pageKeys.has(record.key));
  const source = pageRecords.length ? [...pageRecords, ...unrepresentedRecords] : records;
  return source.map((record) => ({
    key: record.key,
    question: record.question,
    answer: record.answer,
    sensitivity: record.sensitivity,
    ...(Number.isFinite(record.formOrder) ? { formOrder: record.formOrder } : {}),
    ...(Number.isFinite(record.pageNumber) ? { pageNumber: record.pageNumber } : {}),
  }));
}

function mergeJobContext(previous = {}, next = {}) {
  const merged = { ...(previous || {}) };
  for (const key of ['title', 'domain', 'role', 'company', 'jobDescription']) {
    const value = String(next?.[key] || '').trim();
    if (value && (key !== 'jobDescription' || value.length > String(merged[key] || '').length)) merged[key] = value;
  }
  return merged;
}

function readableQuestion(field) {
  const label = String(field?.label || '').trim();
  return Boolean(label && !isOpaqueIdentifier(label) && field?.labelConfidence !== 'low' && label.length <= 1000);
}

function structuredField(field) {
  return ['select', 'select-one', 'radio', 'checkbox'].includes(String(field?.type || '').toLowerCase());
}

function writingField(field) {
  const text = `${field?.label || ''} ${field?.helpText || ''}`.toLowerCase();
  return field?.type === 'textarea' || /\b(why|describe|explain|motivation|cover letter|additional information|tell us about)\b/.test(text);
}

function profileEvidenceRecords(profile = {}) {
  const employment = Array.isArray(profile.employment) ? profile.employment : [];
  return employment.flatMap((entry, index) => {
    const company = String(entry?.company || '').trim();
    const roles = Array.isArray(entry?.roles) ? entry.roles : [];
    const companyRecord = company ? [{ key: `profile:employment:${entry.id || index}`, question: 'Confirmed employer', answer: company, provenance: 'profile', sensitivity: 'safe', confirmationState: 'confirmed' }] : [];
    const roleRecords = roles.map((role, roleIndex) => {
      const title = String(role?.title || role?.role || '').trim();
      return title ? { key: `profile:employment:${entry.id || index}:role:${roleIndex}`, question: 'Employment role', answer: `${title}${company ? ` at ${company}` : ''}`, provenance: 'profile', sensitivity: 'safe', confirmationState: 'confirmed' } : null;
    }).filter(Boolean);
    return [...companyRecord, ...roleRecords];
  });
}

function pageSnapshot(inspection, pageNumber, pageRecords) {
  return {
    pageNumber,
    page: inspection.page,
    values: pageRecords,
  };
}

async function recordPageCapture(run, inspection, pageRecords = [], { promote = false, assertAuthority = null } = {}) {
  pageRecords = pageRecords.map(record => ({ ...record, pageNumber: run.pageNumber }));
  const saved = await persistLearnedRecords(pageRecords, run, { promote, assertAuthority });
  assertAuthority?.();
  run.answers = upsertAnswerRecords(run.answers, pageRecords);
  run.pages = [
    ...run.pages.filter((page) => page.pageNumber !== run.pageNumber),
    pageSnapshot(inspection, run.pageNumber, pageRecords),
  ].slice(-MAX_PAGES);
  run.audit = auditItems(run.answers, run.pages);
  return { run, stats: saved.stats };
}

async function capturePage(tabId, run, inspection) {
  const response = await sendToApplicationFrame(tabId, run, { type: 'JOB_APP_CAPTURE' });
  const captured = await recordPageCapture(run, inspection, response?.records || [], { assertAuthority: () => assertRunSiteAuthority(tabId, run) });
  return captured.run;
}

function navigationIssues(inspection) {
  const labels = {
    file_upload: 'Complete the file upload on the application site',
    captcha: 'Complete the CAPTCHA on the application site',
    login: 'Sign in on the application site',
    unsupported_widget: 'Complete the unsupported or inaccessible widget manually',
    ambiguous_navigation: 'Resolve the page navigation controls manually',
    no_application_frame: 'Select or complete the application form manually; no application frame was found',
    ambiguous_application_frame: 'Select or complete the application form manually; multiple application frames were found',
  };
  return inspection.pauseReasons.map((reason) => ({
    reason: labels[reason] || reason,
    code: reason,
    category: 'pause',
  }));
}

function fieldIssue(field, invalidIds, unresolvedById = new Map(), pageNumber = null) {
  return {
    fieldId: field.id,
    handle: field.handle,
    label: field.labelConfidence === 'low' ? 'Question needs clarification' : (field.label || field.id),
    identifiedLabel: field.label || field.id,
    labelConfidence: field.labelConfidence || (field.label ? 'high' : 'low'),
    helpText: field.helpText || '',
    nearbyContext: field.nearbyContext || '',
    fieldType: field.type,
    fieldOptions: field.options || [],
    fieldConstraints: field.constraints || {},
    fieldMultiple: Boolean(field.multiple),
    ...(Number.isFinite(pageNumber) ? { pageNumber } : {}),
    formOrder: field.formOrder,
    required: Boolean(field.required),
    reason: unresolvedById.get(field.id)?.reason
      || (invalidIds.has(field.id)
        ? 'The current value does not satisfy the field constraints'
        : 'No validated answer is available'),
  };
}

function categorizeRun(run, inspection, validation, unresolvedResults = []) {
  const invalidIds = new Set((validation.invalid || []).map((field) => field.fieldId));
  const unresolvedById = new Map(unresolvedResults.filter((item) => item?.fieldId).map((item) => [item.fieldId, item]));
  const unresolvedFieldsOnPage = inspection.fields
    .filter((field) => !field.currentValue || invalidIds.has(field.id))
    .map((field) => ({
      ...fieldIssue(field, invalidIds, unresolvedById, run.pageNumber),
      ...(run.semanticSearch?.[field.id] ? { semanticStatus: run.semanticSearch[field.id].status } : {}),
      ...(run.suggestions?.[field.id] ? { suggestion: run.suggestions[field.id], reason: run.suggestions[field.id].candidates?.some(candidate => candidate.kind === 'semantic')
        ? 'Saved answer found — review it before use'
        : 'Relevant saved evidence available — approve an answer before use' } : {}),
      ...(run.generatedSuggestions?.[field.id] ? { generatedSuggestion: run.generatedSuggestions[field.id], reason: 'AI drafts are ready for review before sending' } : {}),
      ...(!run.suggestions?.[field.id] && run.semanticSearch?.[field.id]?.status === 'searching' ? { reason: 'Searching saved answers…' } : {}),
      ...(!run.suggestions?.[field.id] && run.semanticSearch?.[field.id]?.status === 'none' ? { reason: 'No clear saved-answer match' } : {}),
      ...(!run.suggestions?.[field.id] && run.semanticSearch?.[field.id]?.status === 'failed' ? { reason: 'Couldn’t search saved answers — try again' } : {}),
    }));
  run.actionRequired = [
    ...navigationIssues(inspection),
    ...unresolvedFieldsOnPage.filter((field) => field.required || invalidIds.has(field.fieldId)),
  ];
  run.optionalUnresolved = unresolvedFieldsOnPage.filter((field) => !field.required && !invalidIds.has(field.fieldId));
  const unresolvedIds = new Set(unresolvedFieldsOnPage.map(field => field.fieldId));
  run.reviewRequired = (run.reviewRequired || []).filter(item => !unresolvedIds.has(item.fieldId));
  run.fieldStates = Object.fromEntries(inspection.fields.map(field => [field.id, { handle: field.handle, status: unresolvedIds.has(field.id) ? (run.suggestions?.[field.id] || run.generatedSuggestions?.[field.id]?.suggestions?.length ? 'review' : 'manual') : 'filled' }]));
  run.audit = auditItems(run.answers, run.pages);
  return run;
}

async function focusFirstProblem(tabId, run, inspection, validation) {
  const invalidIds = new Set((validation.invalid || []).map((field) => field.fieldId));
  const first = inspection.fields.find((field) => field.required && (!field.currentValue || invalidIds.has(field.id)))
    || validation.requiredEmpty?.[0]
    || validation.invalid?.[0];
  if (first?.fieldId || first?.id) {
    try {
      await sendToApplicationFrame(tabId, run, { type: 'JOB_APP_FOCUS', fieldId: first.fieldId || first.id });
    } catch (error) {
      if (error.frameDiscovery) throw error;
    }
  }
  return first?.label || '';
}

function applicationRecordsForLocalReuse(run = {}) {
  return (run.answers || []).filter(record => ['user', 'autofill'].includes(record?.provenance) && String(record?.answer || '').trim())
    .map((record, index) => ({...record, id: record.id || record.key || record.question || index,
      key: `application_${Number(record.pageNumber) || 0}_${record.key || index}`,
      provenance: 'this application', confirmationState: 'confirmed'}));
}

function hasConflictingSemanticEvidence(field, records, allowSensitive) {
  const answers = new Set(records.filter(record => semanticEligible(field, record, { allowSensitive }))
    .map(record => String(record.answer).trim().replace(/\s+/g, ' ')));
  return answers.size > 1;
}

async function applyPageDecisions(tabId, run, inspection, records, coverMessages, profile = {}, datasourceRevision = '', voteAutofillEnabled = true, cycle = {pass: 0, deadline: Date.now() + 8000}, jevOptions = {}) {
  const currentPageSignature = pageSignature(inspection, run.frame);
  if (run.lastAction === 'next' && run.pageSignature === currentPageSignature) {
    run.status = 'waiting_user';
    run.waitingFor = 'navigation_not_detected';
    run.actionRequired = [{ reason: 'The page did not change after Next/Continue.' }];
    run.nextAction = null;
    return { run, inspection, validation: { ok: false, requiredEmpty: [], invalid: [] } };
  }

  run.lastAction = null;
  const pageOrOriginChanged = run.pageSignature !== currentPageSignature;
  if (pageOrOriginChanged || (run.suggestionDatasourceRevision && run.suggestionDatasourceRevision !== datasourceRevision)) run.generatedSuggestions = {};
  if (pageOrOriginChanged) { run.suggestions = {}; run.semanticSearch = {}; }
  else run.suggestions = run.suggestions || {};
  run.pageSignature = currentPageSignature;
  run.suggestionDatasourceRevision = datasourceRevision;
  run.jobContext = mergeJobContext(run.jobContext, inspection.page);
  await saveRun(run);
  const draftRecords = await draftEvidenceRecords();
  let currentInspection = inspection;
  let currentValidation = { ok: false, requiredEmpty: [], invalid: [] };
  let allDecisions = [];
  let appliedReviews = [];
  let unresolvedResults = [];
  let currentSignature = currentPageSignature;
  const firstPass = Math.max(0, Number(cycle.pass) || 0);
  for (let pass = firstPass; pass < 3 && Date.now() < cycle.deadline; pass += 1) {
    const inspectedSignature = pageSignature(currentInspection, run.frame);
    if (inspectedSignature !== currentSignature) {
      currentSignature = inspectedSignature;
      run.pageSignature = currentSignature;
      run.suggestions = {};
      run.generatedSuggestions = {};
      run.semanticSearch = {};
    }
    const scopedFields = resolveEmploymentFields(run, currentInspection.fields, profile);
    const validationResponse = await sendToApplicationFrame(tabId, run, { type: 'JOB_APP_VALIDATE' });
    currentValidation = validationResponse?.validation || { ok: false, requiredEmpty: [], invalid: [] };
    const invalidFieldIds = new Set((currentValidation.invalid || []).map((field) => field.fieldId));
    const voteRecords = [...applicationRecordsForLocalReuse(run), ...records];
    const localDecisions = planDeterministicFill(scopedFields, voteRecords, coverMessages, profile, currentInspection.page, { voteAutofillEnabled }).map(decision => {
      const field = scopedFields.find(field => field.id === decision.fieldId);
      if (!field) return decision;
      if (field.entityUnresolved) return {...decision, action:'ask_user',value:null,disposition:'manual',reason:'Choose the employer for this work-history section'};
      // An existing invalid value must not be silently replaced by deterministic
      // autofill. Keep it unresolved so planner output can be reviewed first.
      if (String(field.currentValue || '').trim() && invalidFieldIds.has(field.id)) {
        return { ...decision, action: 'keep', value: null, reason: 'The current value does not satisfy the field constraints' };
      }
      if (String(field.currentValue || '').trim()) return decision;
      if (jevOptions.enabled && hasConflictingSemanticEvidence(field, records, jevOptions.allowSensitive)) {
        const candidates = savedFieldCandidates(field, records, draftRecords);
        if (candidates.length) run.suggestions[field.id] = { tabId, frameId: run.frame.frameId, applicationId: run.startedAt,
          pageSignature: currentSignature, field, candidates };
        return { ...decision, action: 'ask_user', value: null, disposition: 'manual',
          reason: 'JEV is choosing between conflicting saved answers' };
      }
      const voteWinner = decision.matchKind === 'vote'
        ? voteRecords.find(record => record.key === decision.evidenceKeys?.[0])
        : null;
      const candidates = savedFieldCandidates(field, records, draftRecords, voteWinner ? [voteWinner] : []);
      const choiceMapping = choiceEvidenceNeedsPlanner(field, candidates);
      const gated = candidates.length && !choiceMapping && (decision.action !== 'fill' || decision.disposition !== 'autofill' || field.type === 'textarea' || decision.sensitivity !== 'safe' || inferSensitivity(field.label, field.id) !== 'safe');
      if (gated) {
        const existing = run.suggestions[field.id];
        const plannerCandidate = existing?.candidates?.some((candidate) => candidate.kind === 'planner');
        if (!plannerCandidate) {
          run.suggestions[field.id] = { tabId, frameId: run.frame.frameId, applicationId: run.startedAt, pageSignature: currentSignature, field, candidates };
        }
        return { ...decision, action: 'ask_user', value: null, reason: 'Relevant saved evidence available — approve an answer before use' };
      }
      return decision.disposition === 'autofill' ? decision : {...decision,action:'ask_user',value:null};
    });
    allDecisions.push(...localDecisions);
    const fillable = localDecisions.filter(decision => {
      const field = scopedFields.find(item => item.id === decision.fieldId);
      return decision.action === 'fill' && !String(field?.currentValue || '').trim();
    });
    if (!fillable.length) break;
    const before = JSON.stringify(currentInspection.fields.map(field => [field.id, field.handle, field.currentValue, field.options]));
    const localResult = await sendToApplicationFrame(tabId, run, { type: 'JOB_APP_APPLY', decisions: fillable, deadline: cycle.deadline,
      applicationId: run.startedAt, observationRevision: currentInspection.observation?.revision || '' });
    if (!localResult?.ok) throw new Error(localResult?.error || 'The page rejected local answers');
    appliedReviews.push(...(localResult.result?.reviewRequired || []));
    unresolvedResults.push(...(localResult.result?.unresolved || []));
    const refreshed = await sendToApplicationFrame(tabId, run, { type: 'JOB_APP_INSPECT' });
    const interpretation = activeFormInterpretations.get(tabId);
    currentInspection = interpretation ? interpretInspection(refreshed.inspection, interpretation) : refreshed.inspection;
    const after = JSON.stringify(currentInspection.fields.map(field => [field.id, field.handle, field.currentValue, field.options]));
    if (after === before) break;
  }
  currentSignature = pageSignature(currentInspection, run.frame);
  run.pageSignature = currentSignature;
  for (const suggestion of Object.values(run.suggestions || {})) suggestion.pageSignature = currentSignature;
  const finalValidationResponse = await sendToApplicationFrame(tabId, run, { type: 'JOB_APP_VALIDATE' });
  currentValidation = finalValidationResponse?.validation || { ok: false, requiredEmpty: [], invalid: [] };
  run = await capturePage(tabId, run, currentInspection);
  run.reviewRequired = reviewItems(
    currentInspection.fields,
    allDecisions,
    run.reviewRequired,
    appliedReviews,
    run.pageNumber,
  );
  run.progress = 'local_fill_complete';
  return {
    run: categorizeRun(run, currentInspection, currentValidation, unresolvedResults),
    inspection: currentInspection,
    validation: currentValidation,
  };
}

async function approveSuggestion(message) {
  const { tabId, fieldId } = message;
  if (!Number.isInteger(tabId) || processingTabs.has(tabId) || saveLocks.has(tabId)) throw new Error('Application is busy or unavailable');
  saveLocks.add(tabId);
  try {
    const run = await getRun(tabId);
    const suggestion = run?.suggestions?.[fieldId];
    if (!suggestion || !SAVABLE_RUN_STATUSES.has(run.status) || message.frameId !== run.frame?.frameId
      || message.frameId !== suggestion.frameId || message.applicationId !== run.startedAt
      || message.pageSignature !== run.pageSignature || message.handle !== suggestion.field.handle || !message.handle) throw new Error('Stale suggestion; check the page again');
    await reviewedCandidate(suggestion, message);
    // Never rediscover/reroute an approval into another frame.
    const authority = () => assertRunSiteAuthority(tabId, run);
    const inspected = await sendToFrame(tabId, message.frameId, { type: 'JOB_APP_INSPECT' }, authority);
    const field = resolveEmploymentFields(run, inspected.inspection?.fields || [], (await getDatasource()).profile).find(item => item.id === fieldId);
    if (!field || field.handle !== message.handle || field.currentValue
      || (field.widget !== 'custom' && JSON.stringify(field.options) !== JSON.stringify(suggestion.field.options))
      || field.label !== suggestion.field.label || field.type !== suggestion.field.type
      || pageSignature(inspected.inspection, run.frame) !== message.pageSignature) throw new Error('Destination changed; check the page again');
    const applied = await applyReviewedField({
      tabId, frameId: message.frameId, applicationId: run.startedAt, field, suggestion, message, approvalGuard: null,
      assertAuthority: () => assertRunSiteAuthority(tabId, run),
    });
    delete run.suggestions[fieldId];
    categorizeRun(run, applied.inspection, applied.validation);
    return { ok: true, run: await saveRun(run) };
  } finally { saveLocks.delete(tabId); }
}

function inlineOrigin(message, sender) {
  if (!chrome.runtime.id || sender?.id !== chrome.runtime.id || !Number.isInteger(sender?.tab?.id) || sender.tab.id < 0
    || !Number.isInteger(sender.frameId) || sender.frameId < 0) throw new Error('Invalid inline sender');
  let url;
  try { url = new URL(sender.url); } catch { throw new Error('Invalid inline sender URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || (sender.origin && sender.origin !== url.origin)) throw new Error('Invalid inline sender origin');
  const origin = {tabId: sender.tab.id, frameId: sender.frameId, documentId: sender.documentId ?? null, url: sender.url};
  if (origin.documentId !== null) requiredBoundedText(origin.documentId, 'Document ID', 200);
  for (const key of Object.keys(origin)) {
    if (Object.hasOwn(message, key) && message[key] !== origin[key]) throw new Error('Inline origin does not match the sender');
  }
  requiredBoundedText(message.requestId, 'Request ID', 200);
  for (const key of ['fieldId', 'handle']) if (Object.hasOwn(message, key)) requiredBoundedText(message[key], `Field ${key}`, 1000);
  if (message.type === 'JOB_INLINE_QUERY') {
    if (Object.hasOwn(message, 'applicationId') || Object.hasOwn(message, 'pageSignature')) throw new Error('Inline query origin must come from the sender');
    requiredBoundedText(message.fieldId, 'Field ID', 1000);
    requiredBoundedText(message.handle, 'Field handle', 1000);
  } else if (message.type === 'JOB_INLINE_SEARCH') {
    requiredBoundedText(message.sessionId, 'Session ID', 200);
    if (typeof message.query !== 'string' || message.query.length > 200) throw new Error('Search query must be text of at most 200 characters');
  } else {
    requiredBoundedText(message.sessionId, 'Session ID', 200);
    if (message.type === 'JOB_INLINE_ACCEPT') {
      requiredBoundedText(message.candidateId, 'Candidate ID', 200);
      requiredBoundedText(message.acceptanceToken, 'Acceptance token', 200);
    }
  }
  return origin;
}

function writeInlineSessions(change) {
  const operation = inlineWriteChain.catch(() => {}).then(async () => {
    const stored = await chrome.storage.session.get({[INLINE_STORAGE_KEY]: {}});
    const sessions = stored[INLINE_STORAGE_KEY] || {};
    for (const [key, session] of Object.entries(sessions)) {
      if (!(session.expiresAt > Date.now())) { delete sessions[key]; continue; }
      if (session.generation?.status === 'pending' && session.workerId !== WORKER_ID) {
        session.generation = {...session.generation, status: 'interrupted', error: 'The previous operation was interrupted. Try again.'};
        session.workerId = WORKER_ID;
      }
    }
    const result = change(sessions);
    // Mirror only revocable authority, so apply can check synchronously after its last await.
    inlineSessionAuthorities.clear();
    for (const [key, session] of Object.entries(sessions)) {
      inlineSessionAuthorities.set(key, {sessionId: session.sessionId, revision: session.revision, expiresAt: session.expiresAt});
    }
    await chrome.storage.session.set({[INLINE_STORAGE_KEY]: sessions});
    return result;
  });
  inlineWriteChain = operation;
  return operation;
}

function mutateInlineSession(tabId, frameId, sessionId, change) {
  return writeInlineSessions(sessions => {
    const key = `${tabId}:${frameId}`;
    const current = sessions[key];
    if (sessionId && current?.sessionId !== sessionId) throw new Error('Inline session expired or changed. Focus the field again.');
    const next = change(current || null);
    if (next === false) return null;
    if (next === null) { delete sessions[key]; return null; }
    const result = {...(next || current), revision: (current?.revision || 0) + 1, expiresAt: Date.now() + INLINE_TTL_MS, workerId: WORKER_ID};
    sessions[key] = result;
    return result;
  });
}

function invalidateInlineSessions(tabId, frameId = null) {
  return writeInlineSessions(sessions => {
    for (const [key, session] of Object.entries(sessions)) {
      if (session.tabId === tabId && (frameId === null || session.frameId === frameId)) delete sessions[key];
    }
  });
}

function inlineReply(session, requestId, extra = {}) {
  const generated = session.generatedSuggestions?.[session.field?.id];
  return {ok: true, sessionId: session.sessionId, requestId, field: session.field,
    candidates: [...(session.suggestions?.[session.field?.id]?.candidates || []), ...(generated?.suggestions || [])],
    generatedSuggestion: generated || null, ...extra};
}

function compatibleInlineRun(run, inspection, field, frameId) {
  if (!run || !SAVABLE_RUN_STATUSES.has(run.status) || run.frame?.frameId !== frameId
    || pageSignature(inspection, run.frame) !== run.pageSignature) return null;
  const prior = run.suggestions?.[field.id]?.field || run.generatedSuggestions?.[field.id]?.field;
  if (!(prior ? field.handle === prior.handle && sameFieldSnapshot(field, aiFieldSnapshot(prior))
    : run.fieldStates?.[field.id]?.handle === field.handle)) return null;
  return run;
}

async function inspectInlineDestination(origin, {fieldId, handle, requireFocus = true}, assertAuthority = null) {
  const response = await sendToFrame(origin.tabId, origin.frameId, {type: 'JOB_APP_INSPECT_INLINE', fieldId, handle, requireFocus}, assertAuthority);
  const inspection = response?.inspection;
  const field = inspection?.fields?.find(field => field.id === fieldId && field.handle === handle);
  if (!response?.ok || !field || inspection.page?.url !== origin.url
    || (requireFocus && (response.focusedFieldId !== fieldId || response.focusedHandle !== handle))
    || field.rawValue !== '' || !Number.isInteger(field.editRevision) || field.editRevision < 0
    || (requireFocus && (response.rawValue !== field.rawValue || response.editRevision !== field.editRevision))) {
    throw new Error('Inline destination changed. Focus an empty field again.');
  }
  if (!readableQuestion(field) || !['text', 'textarea', 'email', 'tel', 'url'].includes(field.type)
    || field.widget || field.multiple || inferSensitivity(field.label, field.id) === 'legal') {
    throw new Error('This destination requires manual entry');
  }
  return {inspection, field};
}

async function scopeInlineField(origin, inspection, field) {
  const [run, datasource] = await Promise.all([getRun(origin.tabId), getDatasource()]);
  const compatible = compatibleInlineRun(run, inspection, field, origin.frameId);
  const context = {pageSignature: compatible?.pageSignature || pageSignature(inspection), employmentMappings: {...(compatible?.employmentMappings || {})}};
  const scoped = resolveEmploymentFields(context, inspection.fields, datasource.profile).find(item => item.id === field.id && item.handle === field.handle);
  return {field: scoped, attachedRun: compatible ? {applicationId: compatible.startedAt, frameId: origin.frameId, pageSignature: compatible.pageSignature} : null};
}

async function queryInlineField(message, sender) {
  const origin = inlineOrigin(message, sender);
  const authority = siteAuthority(origin.tabId);
  if (processingTabs.has(origin.tabId) || saveLocks.has(origin.tabId)) throw new Error('Fill is in progress');
  // Reserve first: a later focus query or navigation must revoke this operation even while inspection awaits.
  const reserved = await mutateInlineSession(origin.tabId, origin.frameId, null, () => ({...origin,
    sessionId: crypto.randomUUID(), field: null, suggestions: {}, generatedSuggestions: {},
    generation: {status: 'idle', requestId: crypto.randomUUID()}, attachedRun: null, panelRequested: false}));
  const {inspection, field} = await inspectInlineDestination(origin, message, authority);
  const scoped = await scopeInlineField(origin, inspection, field);
  const [records, drafts] = await Promise.all([getRecords(), draftEvidenceRecords()]);
  const candidates = scoped.field.entityUnresolved ? [] : savedFieldCandidates(scoped.field, records, drafts);
  const current = await inspectInlineDestination(origin, message, authority);
  if (pageSignature(current.inspection) !== pageSignature(inspection) || !sameFieldSnapshot(current.field, aiFieldSnapshot(field))
    || current.field.editRevision !== field.editRevision) throw new Error('Inline destination changed. Focus the field again.');
  const session = await mutateInlineSession(origin.tabId, origin.frameId, reserved.sessionId, currentSession => {
    const savedCandidates = candidates.map(candidate => ({...candidate, candidateId: `saved:${currentSession.revision + 1}:${crypto.randomUUID()}`}));
    const signature = pageSignature(inspection);
    return {...currentSession, field: scoped.field, pageSignature: signature, jobContext: inspection.page,
      attachedRun: scoped.attachedRun, suggestions: {[field.id]: {...origin, applicationId: scoped.attachedRun?.applicationId || reserved.sessionId,
        pageSignature: signature, field: scoped.field, candidates: savedCandidates}}};
  });
  return inlineReply(session, message.requestId, scoped.field.entityUnresolved ? {error: 'Choose the employer for this work-history section'} : {});
}

async function guardInlineField(message, sender, {requireFocus = true} = {}) {
  const origin = inlineOrigin(message, sender);
  const authority = siteAuthority(origin.tabId);
  const session = await writeInlineSessions(sessions => sessions[`${origin.tabId}:${origin.frameId}`]);
  if (!session || session.sessionId !== message.sessionId || !session.field
    || Object.keys(origin).some(key => session[key] !== origin[key])) throw new Error('Inline session expired or destination changed');
  const destination = {fieldId: session.field.id, handle: session.field.handle, pageSignature: session.pageSignature,
    applicationId: session.attachedRun?.applicationId || session.sessionId};
  if (Object.keys(destination).some(key => Object.hasOwn(message, key) && message[key] !== destination[key])) throw new Error('Inline destination origin does not match the session');
  const {inspection, field} = await inspectInlineDestination(origin, {fieldId: session.field.id, handle: session.field.handle, requireFocus}, authority);
  if (pageSignature(inspection) !== session.pageSignature || !sameFieldSnapshot(field, aiFieldSnapshot(session.field))
    || field.editRevision !== session.field.editRevision || field.rawValue !== session.field.rawValue) throw new Error('Inline destination changed');
  const scoped = await scopeInlineField(origin, inspection, field);
  if (scoped.field.entityUnresolved || ['entityId', 'entityType', 'employmentId'].some(key => scoped.field[key] !== session.field[key])) {
    throw new Error('Choose the employer for this work-history section');
  }
  if (session.attachedRun && JSON.stringify(scoped.attachedRun) !== JSON.stringify(session.attachedRun)) throw new Error('The application changed. Focus the field again.');
  const latest = await writeInlineSessions(sessions => sessions[`${origin.tabId}:${origin.frameId}`]);
  if (!latest || latest.sessionId !== session.sessionId || latest.revision !== session.revision) throw new Error('Inline session changed');
  authority();
  return {session: latest, inspection, field: scoped.field, authority};
}

const PANEL_OPEN_FALLBACK = 'Open the extension toolbar button to continue editing';

async function inlinePanelState(message) {
  if (!Number.isInteger(message.tabId)) throw new Error('The selected tab is unavailable');
  if (message.close) {
    requiredBoundedText(message.inlineSessionId, 'Session ID', 200);
    await mutateInlineSession(message.tabId, message.frameId, message.inlineSessionId, current => ({...current, panelRequested: false}));
  }
  // Read without writing: a panel refresh must not trigger another storage refresh.
  const stored = await chrome.storage.session.get({[INLINE_STORAGE_KEY]: {}});
  const sessions = Object.values(stored[INLINE_STORAGE_KEY] || {}).filter(session => session.tabId === message.tabId
    && session.panelRequested && session.field && session.expiresAt > Date.now());
  sessions.sort((a, b) => b.panelRequestedAt - a.panelRequestedAt);
  return {ok: true, inlineSession: sessions[0] || null};
}

async function handoffInlineField(message, sender, opening) {
  const request = {...message, requestId: message.requestId || crypto.randomUUID()};
  const {session} = await guardInlineField(request, sender, {requireFocus: false});
  if (message.candidateId && !inlineReply(session).candidates.some(candidate => candidate.candidateId === message.candidateId)) {
    throw new Error('Inline candidate expired. Focus the field again.');
  }
  const error = await opening;
  const saved = await writeInlineSessions(sessions => {
    const key = `${session.tabId}:${session.frameId}`;
    const current = sessions[key];
    if (!current || current.sessionId !== session.sessionId || current.revision !== session.revision) throw new Error('Inline session changed');
    for (const previous of Object.values(sessions)) {
      if (previous.tabId === session.tabId && previous.panelRequested) {
        previous.panelRequested = false;
        previous.revision += 1;
      }
    }
    return sessions[key] = {...current, panelRequested: true, panelRequestedAt: Date.now(), panelCandidateId: message.candidateId || null,
      revision: current.revision + 1, expiresAt: Date.now() + INLINE_TTL_MS, workerId: WORKER_ID};
  });
  return {ok: true, inlineSession: saved, ...(error ? {error} : {})};
}

// Called only after the runtime listener's existing trusted-extension sender guard.
async function guardedPanelInline(message) {
  requiredBoundedText(message.inlineSessionId, 'Session ID', 200);
  const stored = await chrome.storage.session.get({[INLINE_STORAGE_KEY]: {}});
  const session = stored[INLINE_STORAGE_KEY]?.[`${message.tabId}:${message.frameId}`];
  if (!session?.panelRequested || session.sessionId !== message.inlineSessionId) throw new Error('Inline panel session expired or closed');
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (tab?.id !== session.tabId) throw new Error('The selected tab changed');
  await assertTabFormActive(session.tabId, tab);
  if (processingTabs.has(session.tabId) || saveLocks.has(session.tabId)) throw new Error('Fill is in progress');
  const sender = {id: chrome.runtime.id, tab: {id: session.tabId}, frameId: session.frameId, documentId: session.documentId, url: session.url};
  const request = {...message, sessionId: session.sessionId, requestId: crypto.randomUUID()};
  const guarded = await guardInlineField(request, sender, {requireFocus: false});
  return {...guarded, sender, request, suggestion: guarded.session.suggestions?.[guarded.field.id]};
}

async function inlinePanelAction(message) {
  const context = await guardedPanelInline(message);
  const {session, field, sender, request, authority} = context;
  if (message.type === 'JOB_RUN_FOCUS_FIELD') {
    const response = await sendToFrame(session.tabId, session.frameId, {type: 'JOB_APP_FOCUS', fieldId: field.id, handle: field.handle}, authority);
    if (!response?.ok) throw new Error(response?.error || 'Could not show this field on the page');
    return {ok: true, inlineSession: session};
  }
  if (message.type === 'JOB_RUN_REWRITE_ANSWER') {
    const response = await rewriteAnswer(message, context);
    const current = await guardedPanelInline(message);
    return {...response, inlineSession: current.session};
  }
  if (message.type === 'JOB_RUN_GENERATE_SUGGESTIONS') {
    const response = await generateInlineField(request, sender, {requireFocus: false, jobDescription: message.jobDescription});
    if (response.error) throw new Error(response.error);
    return {ok: true, inlineSession: (await guardedPanelInline(message)).session};
  }
  if (message.type === 'JOB_RUN_SEARCH_ANSWERS') {
    const candidates = await savedSearchCandidates(field, message.query);
    const current = await guardedPanelInline(message);
    const saved = await mutateInlineSession(session.tabId, session.frameId, session.sessionId, latest => {
      if (latest.revision !== current.session.revision) throw new Error('Inline session changed. Search again.');
      return {...latest, suggestions: {...latest.suggestions, [field.id]: {...latest.suggestions[field.id], field, candidates}}};
    });
    return {ok: true, candidates, inlineSession: saved};
  }
  if (message.type === 'JOB_RUN_SEMANTIC_SEARCH') {
    const response = await semanticSearchInlineField(request, sender, {requireFocus: false});
    const current = await guardedPanelInline(message);
    return {...response, candidates: response.semanticCandidate ? [response.semanticCandidate] : [], inlineSession: current.session};
  }
  if (!['JOB_RUN_APPLY_DRAFT', 'JOB_RUN_APPROVE_SUGGESTION'].includes(message.type)) throw new Error('Unsupported inline panel action');
  const answer = message.type === 'JOB_RUN_APPLY_DRAFT' ? requiredBoundedText(message.answer, 'Answer', MAX_DRAFT_CHARS) : message.answer;
  if (answer != null && isOpaqueIdentifier(answer)) throw new Error('Internal IDs must be entered manually on the application page');
  if (processingTabs.has(session.tabId) || saveLocks.has(session.tabId)) throw new Error('Fill is in progress');
  saveLocks.add(session.tabId);
  let saved;
  try {
    const current = await guardInlineField(request, sender, {requireFocus: false});
    await applyReviewedField({tabId: session.tabId, frameId: session.frameId, applicationId: session.attachedRun?.applicationId,
      field: current.field, suggestion: message.type === 'JOB_RUN_APPROVE_SUGGESTION' ? current.session.suggestions[field.id] : null,
      message: {...message, ...(answer != null ? {answer} : {})},
      approvalGuard: {expectedRawValue: session.field.rawValue, expectedEditRevision: session.field.editRevision},
      assertAuthority: () => {
        const authority = inlineSessionAuthorities.get(`${session.tabId}:${session.frameId}`);
        if (!authority || authority.sessionId !== session.sessionId || authority.revision !== current.session.revision || authority.expiresAt <= Date.now()) {
          throw new Error('Inline session expired or revoked before applying');
        }
      }});
    saved = await mutateInlineSession(session.tabId, session.frameId, session.sessionId, latest => ({...latest,
      suggestions: {}, generatedSuggestions: {}, panelCandidateId: null, applied: true}));
  } finally { saveLocks.delete(session.tabId); }
  return {ok: true, inlineSession: saved, ...(session.attachedRun ? {run: await validatePageOnly(session.tabId)} : {})};
}

async function acceptInlineField(message, sender) {
  const origin = inlineOrigin(message, sender);
  if (processingTabs.has(origin.tabId) || saveLocks.has(origin.tabId)) throw new Error('Fill is in progress');
  saveLocks.add(origin.tabId);
  let session;
  let result;
  try {
    ({session} = await guardInlineField(message, sender, {requireFocus: false}));
    const suggestion = session.suggestions?.[session.field.id];
    const generated = session.generatedSuggestions?.[session.field.id];
    const draft = generated?.suggestions.find(item => item.candidateId === message.candidateId);
    const candidate = draft || suggestion?.candidates.find(item => item.candidateId === message.candidateId);
    if (!candidate) throw new Error('Inline candidate expired. Focus the field again.');
    // Only worker-stored candidate keys/answers authorize the shared reviewed write.
    const approval = {sourceKeys: sourceKeysForCandidate(candidate)};
    if (!draft) await reviewedCandidate(suggestion, approval);
    const guarded = await guardInlineField(message, sender, {requireFocus: false});
    if (guarded.session.revision !== session.revision) throw new Error('Inline session changed');
    if (draft && !(await currentInlineDestination(session, generated.snapshot))) {
      throw new Error('The page or supporting evidence changed. Generate again.');
    }
    // A fresh approval object avoids reusing the preflight evidence cache across the awaited guard.
    await applyReviewedField({tabId: origin.tabId, frameId: origin.frameId, applicationId: session.attachedRun?.applicationId,
      field: guarded.field, suggestion: draft ? null : suggestion,
      message: draft ? {answer: requiredBoundedText(draft.answer, 'Answer', MAX_DRAFT_CHARS)} : {sourceKeys: sourceKeysForCandidate(candidate)},
      assertAuthority: () => {
        const current = inlineSessionAuthorities.get(`${origin.tabId}:${origin.frameId}`);
        if (!current || current.sessionId !== session.sessionId || current.revision !== session.revision || !(current.expiresAt > Date.now())) {
          throw new Error('Inline session expired or revoked before applying');
        }
      },
      approvalGuard: {expectedRawValue: session.field.rawValue, expectedEditRevision: session.field.editRevision, acceptanceToken: message.acceptanceToken}});
    result = inlineReply(session, message.requestId, {candidates: [], generatedSuggestion: null});
  } finally {
    try {
      if (session) await mutateInlineSession(origin.tabId, origin.frameId, session.sessionId, current => ({...current, suggestions: {}, generatedSuggestions: {}})).catch(() => {});
    } finally { saveLocks.delete(origin.tabId); }
  }
  if (session.attachedRun) await validatePageOnly(origin.tabId);
  return result;
}

function inlineJobContext(session, inspection, run) {
  return mergeJobContext(mergeJobContext({}, run?.jobContext || session.jobContext), inspection.page);
}

function draftFieldKey(tabId, frameId, field) {
  return JSON.stringify([tabId, frameId, field.id, field.handle, field.rawValue, field.editRevision]);
}

function claimDraftField(key, owner) {
  if (draftFieldOwners.has(key)) return false;
  draftFieldOwners.set(key, owner);
  return true;
}

function releaseDraftField(key, owner) {
  if (draftFieldOwners.get(key) === owner) draftFieldOwners.delete(key);
}

async function currentInlineDestination(session, snapshot) {
  try {
    const origin = {tabId: session.tabId, frameId: session.frameId, documentId: session.documentId, url: session.url};
    const sender = {id: chrome.runtime.id, tab: {id: session.tabId}, frameId: session.frameId, documentId: session.documentId, url: session.url};
    const current = await guardInlineField({...origin, sessionId: session.sessionId, requestId: snapshot.requestId}, sender, {requireFocus: false});
    if (current.session.revision !== session.revision || current.session.workerId !== snapshot.workerId
      || current.session.generation.requestId !== snapshot.requestId
      || !sameFieldSnapshot(current.field, snapshot.field)
      || current.field.rawValue !== snapshot.field.rawValue || current.field.editRevision !== snapshot.field.editRevision
      || JSON.stringify(current.inspection.page) !== snapshot.pageContext) return null;
    const [settings, datasource, run] = await Promise.all([getSettings(), getDatasource(), getRun(session.tabId)]);
    if (settings.aiProvider !== snapshot.settings.aiProvider || settings.aiModel !== snapshot.settings.aiModel) return null;
    const compatible = compatibleInlineRun(run, current.inspection, current.field, session.frameId);
    if (JSON.stringify(compatible?.jobContext || {}) !== snapshot.runJobContext) return null;
    const jobContext = inlineJobContext(session, current.inspection, compatible);
    if (snapshot.jobDescription) jobContext.jobDescription = snapshot.jobDescription;
    if (aiEvidenceRevision({jobContext}, current.inspection, datasource) !== snapshot.evidenceRevision) return null;
    return current;
  } catch { return null; }
}

async function generateInlineField(message, sender, {requireFocus = true, jobDescription = ''} = {}) {
  const origin = inlineOrigin(message, sender);
  if (processingTabs.has(origin.tabId) || saveLocks.has(origin.tabId)) throw new Error('Fill is in progress');
  const {session, inspection, field} = await guardInlineField(message, sender, {requireFocus});
  if (session.generation.status === 'pending') return inlineReply(session, message.requestId, {error: 'This answer is already being prepared'});
  const [settings, datasource, run] = await Promise.all([getSettings(), getDatasource(), getRun(origin.tabId)]);
  const compatible = compatibleInlineRun(run, inspection, field, origin.frameId);
  const jobContext = inlineJobContext(session, inspection, compatible);
  if (jobDescription) jobContext.jobDescription = requiredBoundedText(jobDescription, 'Job description', 16_000);
  const snapshot = {field: aiFieldSnapshot(field), settings: {aiProvider: settings.aiProvider, aiModel: settings.aiModel},
    requestId: message.requestId, workerId: WORKER_ID, pageContext: JSON.stringify(inspection.page), jobDescription: jobDescription || '',
    runJobContext: JSON.stringify(compatible?.jobContext || {}),
    evidenceRevision: aiEvidenceRevision({jobContext}, inspection, datasource)};
  const cached = compatible?.generatedSuggestions?.[field.id];
  const reusable = cached?.snapshot && sameFieldSnapshot(field, cached.snapshot.field)
    && cached.snapshot.field.rawValue === field.rawValue && cached.snapshot.field.editRevision === field.editRevision
    && cached.snapshot.evidenceRevision === snapshot.evidenceRevision
    && cached.snapshot.settings.aiProvider === settings.aiProvider && cached.snapshot.settings.aiModel === settings.aiModel;
  if (!reusable && compatible?.aiOperations?.[`suggestion:${field.id}`]?.status === 'pending') {
    return inlineReply(session, message.requestId, {error: 'This answer is already being prepared'});
  }
  const sessionId = String(origin.tabId) + ':' + (session.attachedRun?.applicationId || session.sessionId);
  const traceContext = createPhoenixTrace(sessionId, {'phoenix.action': 'answer_suggestions', 'application.field_id': field.id, 'inline.reused': Boolean(reusable)});
  await persistPhoenixAction(traceContext, 'answer_suggestions', sessionId, {'application.field_id': field.id, 'inline.reused': Boolean(reusable)});
  void tracePhoenixEvent('answer_suggestions', {'application.field_id': field.id, 'inline.reused': Boolean(reusable)}, sessionId, {traceContext, root: true, defer: true, input: {field, jobContext, evidenceRevision: snapshot.evidenceRevision}});
  const apiKey = reusable ? null : await getApiKey(settings.aiProvider);
  if (!reusable && !apiKey) {
    void tracePhoenixEvent('answer_suggestions', {'ai.skipped': true, 'ai.reason': 'missing_provider_key'}, sessionId, {traceContext, root: true, output: {retained: false, reason: 'missing_provider_key'}});
    void clearPhoenixAction(traceContext);
    throw new Error(missingProviderKeyMessage(settings.aiProvider));
  }
  const draftKey = draftFieldKey(origin.tabId, origin.frameId, field), owner = crypto.randomUUID();
  if (!reusable && !claimDraftField(draftKey, owner)) return inlineReply(session, message.requestId, {error: 'This answer is already being prepared'});
  let pending;
  let traceOutcome = {retained: false, reason: 'incomplete'};
  try {
    pending = await mutateInlineSession(origin.tabId, origin.frameId, session.sessionId, current => {
      if (processingTabs.has(origin.tabId) || saveLocks.has(origin.tabId)) throw new Error('Fill is in progress');
      if (current.generation.status === 'pending' || current.revision !== session.revision) return false;
      return {...current, generation: {status: 'pending', requestId: message.requestId}};
    });
    if (!pending) return inlineReply(session, message.requestId, {error: 'This answer is already being prepared'});
    if (!(await currentInlineDestination(pending, snapshot))) throw new Error('The page or supporting evidence changed. Generate again.');
    const generated = reusable ? cached : await generateFieldDrafts({field, inspection, jobContext, datasource, records: datasource.answerRecords, settings, apiKey, sessionId, traceContext});
    if (!(await currentInlineDestination(pending, snapshot))) throw new Error('The page or supporting evidence changed. Generate again.');
    const committed = await mutateInlineSession(origin.tabId, origin.frameId, pending.sessionId, current => {
      if (processingTabs.has(origin.tabId) || saveLocks.has(origin.tabId)) throw new Error('Fill is in progress');
      if (current.workerId !== WORKER_ID || current.revision !== pending.revision || current.generation.requestId !== message.requestId || current.generation.status !== 'pending') return false;
      const suggestions = generated.suggestions.map(draft => ({answer: draft.answer, evidenceKeys: draft.evidenceKeys,
        candidateId: `generated:${crypto.randomUUID()}`, kind: 'generated', requiresApproval: false}));
      return {...current, generation: {status: 'completed', requestId: message.requestId},
        generatedSuggestions: {...current.generatedSuggestions, [field.id]: {suggestions, missingContext: generated.missingContext, snapshot}}};
    });
    if (!committed) throw new Error('Inline session changed. Generate again.');
    traceOutcome = {retained: true, suggestionCount: generated.suggestions?.length || 0};
    void tracePhoenixEvent('answer_suggestions_result', {'application.field_id': field.id, 'ai.suggestion_count': generated.suggestions?.length || 0, 'ai.retained': true}, sessionId, {traceContext, output: {...generated, retained: true}});
    return inlineReply(committed, message.requestId);
  } catch (error) {
    traceOutcome = {retained: false, reason: error.message};
    void tracePhoenixEvent('answer_suggestions_result', {'application.field_id': field.id, 'ai.validation_error': error.message, 'ai.retained': false}, sessionId, {traceContext, statusCode: 'ERROR', statusMessage: error.message, output: {retained: false, reason: error.message}});
    if (pending) await mutateInlineSession(origin.tabId, origin.frameId, pending.sessionId, current => {
      if (current.workerId !== WORKER_ID || current.generation.status !== 'pending' || current.revision !== pending.revision || current.generation.requestId !== message.requestId) return false;
      return {...current, generation: {status: 'failed', requestId: message.requestId, error: error.message}};
    }).catch(() => {});
    throw error;
  } finally {
    void tracePhoenixEvent('answer_suggestions', {'application.field_id': field.id, 'ai.retained': Boolean(traceOutcome.retained)}, sessionId, {traceContext, root: true, statusCode: traceOutcome.retained ? 'OK' : 'ERROR', statusMessage: traceOutcome.reason || '', output: traceOutcome});
    void clearPhoenixAction(traceContext);
    releaseDraftField(draftKey, owner);
  }
}

// Completed suggestions survive worker suspension; foreign pending jobs cannot silently succeed.
writeInlineSessions(() => null).catch(() => {});

function listedRunField(run, fieldId) {
  return [...(run.actionRequired || []), ...(run.optionalUnresolved || [])]
    .find((item) => item?.fieldId === fieldId) || null;
}

function sameFieldSnapshot(field, snapshot = {}) {
  if (!snapshot || typeof snapshot !== 'object') return true;
  if (snapshot.handle && field.handle !== snapshot.handle) return false;
  if (snapshot.rawValue !== undefined && field.rawValue !== snapshot.rawValue) return false;
  if (snapshot.editRevision !== undefined && field.editRevision !== snapshot.editRevision) return false;
  if (snapshot.label && field.label !== snapshot.label) return false;
  if (snapshot.fieldType && field.type !== snapshot.fieldType) return false;
  // Custom menus render their options only while open. Their observed choices
  // belong to the AI request, while the closed live widget correctly reports none.
  if (snapshot.fieldOptions && snapshot.fieldWidget !== 'custom' && JSON.stringify(field.options || []) !== JSON.stringify(snapshot.fieldOptions)) return false;
  if (snapshot.fieldConstraints && JSON.stringify(field.constraints || {}) !== JSON.stringify(snapshot.fieldConstraints)) return false;
  if (snapshot.fieldMultiple != null && Boolean(field.multiple) !== Boolean(snapshot.fieldMultiple)) return false;
  for (const key of ['helpText','nearbyContext','section','labelConfidence','entityId','entityType']) {
    if (Object.hasOwn(snapshot,key) && String(field[key] || '') !== snapshot[key]) return false;
  }
  return true;
}

async function guardedDraftField(message, { allowSaveLock = false } = {}) {
  const { tabId, fieldId } = message;
  if (!Number.isInteger(tabId) || !fieldId || typeof fieldId !== 'string') throw new Error('The application field is unavailable');
  if (processingTabs.has(tabId) || (!allowSaveLock && saveLocks.has(tabId))) throw new Error('Application is busy or unavailable');
  const run = await getRun(tabId);
  const authority = siteAuthority(tabId);
  const listed = listedRunField(run, fieldId);
  const suggestion = run?.suggestions?.[fieldId] || null;
  if (!run || !listed || !SAVABLE_RUN_STATUSES.has(run.status)
    || message.frameId !== run.frame?.frameId || message.applicationId !== run.startedAt
    || message.pageSignature !== run.pageSignature || !message.handle || message.handle !== listed.handle) {
    throw new Error('Stale draft; check the page again');
  }
  // Never rediscover/reroute a draft operation into another frame.
  const inspected = await sendToFrame(tabId, message.frameId, { type: 'JOB_APP_INSPECT' }, authority);
  const field = inspected.inspection?.fields.find((item) => item.id === fieldId);
  if (!field || field.handle !== message.handle
    || !sameFieldSnapshot(field, listed)
    || (suggestion?.field && !sameFieldSnapshot(field, {
      handle: suggestion.field.handle,
      label: suggestion.field.label,
      fieldType: suggestion.field.type,
      fieldOptions: suggestion.field.options,
      fieldConstraints: suggestion.field.constraints,
      fieldMultiple: suggestion.field.multiple,
    }))
    || pageSignature(inspected.inspection, run.frame) !== message.pageSignature) {
    throw new Error('Destination changed; check the page again');
  }
  if (field.currentValue) {
    const validation = await sendToFrame(tabId, message.frameId, { type: 'JOB_APP_VALIDATE' }, authority);
    if (!validation?.validation?.invalid?.some((item) => item.fieldId === fieldId)) {
      throw new Error('Destination changed; check the page again');
    }
  }
  return { run, listed, suggestion, field, authority };
}

function sourceKeysFromMessage(message = {}) {
  return [...new Set([
    ...(Array.isArray(message.sourceKeys) ? message.sourceKeys : []),
    message.sourceKey,
  ].filter((key) => typeof key === 'string' && key))];
}

function sourceKeysForCandidate(candidate = {}) {
  return [...new Set([
    ...(Array.isArray(candidate.sourceKeys) ? candidate.sourceKeys : []),
    candidate.sourceKey,
  ].filter((key) => typeof key === 'string' && key))];
}

function sourceAnswerSnapshot(candidate = {}, key) {
  const snapshots = candidate.sourceAnswers;
  if (snapshots && !Array.isArray(snapshots) && typeof snapshots === 'object'
    && Object.prototype.hasOwnProperty.call(snapshots, key)) return String(snapshots[key]);
  if (Array.isArray(snapshots)) {
    const snapshot = snapshots.find((item) => item?.key === key);
    if (snapshot && typeof snapshot.answer === 'string') return snapshot.answer;
  }
  // Older runs stored a single sourceKey and candidate answer only.
  return candidate.sourceKey === key ? String(candidate.answer ?? '') : null;
}

function sameKeys(left = [], right = []) {
  return left.length === right.length && left.every((key) => right.includes(key));
}

async function reviewedCandidate(suggestion, message) {
  const cached = reviewedCandidateCache.get(message);
  if (cached?.suggestion === suggestion) return cached.result;
  const requestedKeys = sourceKeysFromMessage(message);
  const candidate = suggestion.candidates.find((item) => {
    const candidateKeys = sourceKeysForCandidate(item);
    return requestedKeys.length > 0 && sameKeys(candidateKeys, requestedKeys);
  });
  const sourceKeys = sourceKeysForCandidate(candidate);
  const records = candidate?.kind === 'draft' ? await draftEvidenceRecords()
    : await getRecords({ includeProfile: sourceKeysForCandidate(candidate).some(key => key.startsWith('profile:')) });
  const sources = sourceKeys.map((key) => records.find((record) => record.key === key));
  const compatibleEvidence = candidate?.kind === 'planner'
    ? rankSuggestionEvidence(suggestion.field, records, {limit: records.length})
    : candidate?.kind === 'semantic'
      ? sources.filter(source => semanticEligible(suggestion.field, source)
        && semanticRecordRevision(source) === candidate.sourceRevision)
      : candidate?.kind === 'semantic_option'
        ? sources.filter(source => candidate.sourceRevisions?.[source.key] === semanticRecordRevision(source))
      : searchEvidence(suggestion.field, sources.filter(Boolean), {limit: sources.length, query: candidate?.searchQuery || ''});
  if (!candidate || !sourceKeys.length || sources.some((source) => !source)
    || sources.some((source) => source.answer !== sourceAnswerSnapshot(candidate, source.key))
    || sources.some((source) => !compatibleEvidence.some((item) => (item.sourceKey || item.key) === source.key))) {
    throw new Error('Saved evidence changed; check again');
  }
  const result = { candidate, sourceKeys, sources, compatibleEvidence };
  reviewedCandidateCache.set(message, { suggestion, result });
  return result;
}

async function applyReviewedField({ tabId, frameId, applicationId, field, suggestion, message, approvalGuard, assertAuthority }) {
  let candidate = null;
  let sourceKeys = [];
  let sources = [];
  let compatibleEvidence = [];
  if (suggestion) {
    ({ candidate, sourceKeys, sources, compatibleEvidence } = await reviewedCandidate(suggestion, message));
  }
  const value = candidate ? String(message.answer ?? candidate.answer).trim() : String(message.answer);
  const validation = validateFillValue(field.widget === 'custom' ? {...field, options: [], optionsStatus: ''} : field, value);
  const sourceCompatible = !candidate || (candidate.kind === 'planner'
    ? sources.every((item) => compatibleEvidence.some((evidence) => (evidence.sourceKey || evidence.key) === item.key))
    : candidate.kind === 'semantic'
      ? sources.length === 1 && semanticEligible(field, sources[0])
        && semanticRecordRevision(sources[0]) === candidate.sourceRevision
      : candidate.kind === 'semantic_option'
        ? sources.every(source => candidate.sourceRevisions?.[source.key] === semanticRecordRevision(source))
      : meaningCompatible(field, sources[0], { numericReview: !(['textarea', 'text'].includes(field.type) && value === candidate.answer) }));
  if (!validation.ok || !sourceCompatible || inferSensitivity(field.label, field.id) === 'legal') {
    throw new Error(validation.ok ? 'This destination requires manual entry' : validation.reason);
  }
  const currentSnapshot = async () => {
    const inspected = await sendToFrame(tabId, frameId, {type: 'JOB_APP_INSPECT'}, assertAuthority);
    const current = inspected.inspection?.fields.find(item => item.id === field.id && item.handle === field.handle);
    if (!current || current.currentValue !== field.currentValue || !sameFieldSnapshot(current, aiFieldSnapshot(field))) {
      throw new Error('The field changed before the answer could be applied');
    }
    return {field: current, revision: inspected.inspection.observation?.revision || ''};
  };
  const requestFor = ({field: current, revision}) => ({
    type: 'JOB_APP_APPLY',
    applicationId,
    observationRevision: revision,
    ...(approvalGuard ? {approvalGuard} : {}),
    decisions: [{
      fieldId: current.id,
      handle: current.handle,
      action: 'fill',
      approved: true,
      value,
      evidenceKeys: sourceKeys,
      sensitivity: inferSensitivity(current.label, current.id),
      confidence: 'high',
      reason: candidate ? 'Explicitly approved saved answer' : 'Explicitly entered draft answer',
      ...(approvalGuard || {}),
      expectedRawValue: current.rawValue ?? '',
      expectedEditRevision: current.editRevision ?? 0,
    }],
  });
  let snapshot = await currentSnapshot();
  let result = await sendToFrame(tabId, frameId, requestFor(snapshot), assertAuthority);
  const needsTrustedOpen = frameId === 0 && field.widget === 'custom' && field.rect && result?.ok
    && result.result?.unresolved?.some(item => item.fieldId === field.id && /did not reveal any options/i.test(item.reason || ''));
  if (needsTrustedOpen) {
    await sendToFrame(tabId, frameId, {type: 'JOB_APP_EXPECT_TRUSTED_INPUT', handle: field.handle}, assertAuthority);
    const opened = await browserController.click(tabId, field.rect, frameId);
    await sendToFrame(tabId, frameId, {type: 'JOB_APP_EXPECT_TRUSTED_INPUT', clear: true}, assertAuthority);
    if (opened.ok) {
      snapshot = await currentSnapshot();
      assertAuthority?.();
      result = await sendToFrame(tabId, frameId, requestFor(snapshot), assertAuthority);
    }
  }
  if (!result?.ok) throw new Error(result?.error || 'Could not apply the answer');
  assertAuthority?.();
  const verified = await sendToFrame(tabId, frameId, { type: 'JOB_APP_INSPECT' }, assertAuthority);
  if (verified.inspection?.fields.find((item) => item.id === field.id && item.handle === field.handle)?.currentValue !== value) {
    throw new Error(candidate ? 'The page did not retain the approved answer' : 'The page did not retain the entered answer');
  }
  if (candidate) {
    const source = sources[0];
    datasourceWriteChain = datasourceWriteChain.catch(() => {}).then(async () => {
      const state = await getDatasource();
      const latestRecords = candidate.kind === 'draft' ? await draftEvidenceRecords() : [...state.answerRecords, ...profileEvidenceRecords(state.profile)];
      const latestSources = sourceKeys.map((key) => latestRecords.find((record) => record.key === key));
      if (latestSources.some((latest) => !latest || latest.answer !== sourceAnswerSnapshot(candidate, latest.key))) {
        throw new Error('Evidence changed while applying; answer applied but not learned');
      }
      const now = new Date().toISOString();
      const equivalent = candidate.kind === 'equivalent' && sourceKeys.length === 1 && value === candidate.answer && field.labelConfidence !== 'low';
      const answerRecords = equivalent ? state.answerRecords.map((record) => record.key === source.key
        ? { ...record, aliases: [...new Set([...(record.aliases || []), field.label])], updatedAt: now } : record)
        : mergeLearnedAnswers(state.answerRecords, [{ question: field.label, answer: value, type: field.type, entityId: field.entityId,
          entityType: field.entityType, evidenceKeys: sourceKeys, provenance: 'user', completed: true, userEdited: true }], now, { confirm: true });
      await saveDatasource({ ...state, answerRecords });
      const readback = await chrome.storage.local.get({ answerRecords: [] });
      const persisted = equivalent ? readback.answerRecords.find((record) => record.key === source.key && record.aliases?.includes(field.label))
        : readback.answerRecords.find((record) => record.question === field.label && record.answer === value && sourceKeys.every((key) => record.evidenceKeys?.includes(key)));
      if (!persisted) throw new Error('Answer applied, but reusable save could not be verified');
    });
    await datasourceWriteChain.catch(error => { throw new Error(`Answer applied, but not saved: ${error.message}`); });
  }
  const validationResponse = await sendToFrame(tabId, frameId, { type: 'JOB_APP_VALIDATE' }, assertAuthority);
  if(candidate?.kind==='semantic') void tracePhoenixEvent('saved_answer_match_feedback', {
    'llm.provider':'typesafe','llm.model_name':candidate.semantic?.model || '',
    'typesafe.accepted':1,'typesafe.corrected':Number(value!==candidate.answer),
  },`${tabId}:${applicationId}`);
  return { inspection: verified.inspection, validation: validationResponse?.validation || {}, value };
}

async function rewriteEvidence(suggestion, message) {
  const requestedKeys = sourceKeysFromMessage(message);
  if (!requestedKeys.length) return [];
  const candidate = suggestion?.candidates?.find((item) => sameKeys(sourceKeysForCandidate(item), requestedKeys));
  if (!candidate) throw new Error('Saved evidence changed; choose an answer again');
  const records = candidate.kind === 'draft' ? await draftEvidenceRecords() : await getRecords();
  const relevant = records.filter((record) => requestedKeys.includes(record.key));
  const compatible = candidate.kind === 'planner'
    ? rankSuggestionEvidence(suggestion.field, records, {limit: records.length})
    : searchEvidence(suggestion.field, relevant, {limit: relevant.length, query: candidate.searchQuery || ''});
  if (relevant.length !== requestedKeys.length
    || relevant.some(record => record.answer !== sourceAnswerSnapshot(candidate, record.key)
      || !compatible.some(item => (item.sourceKey || item.key) === record.key))) {
    throw new Error('Saved evidence changed; choose an answer again');
  }
  return relevant;
}

async function applyDraft(message) {
  const answer = requiredBoundedText(message.answer, 'Answer', MAX_DRAFT_CHARS);
  if (isOpaqueIdentifier(answer)) throw new Error('Internal IDs must be entered manually on the application page');
  const { tabId } = message;
  if (!Number.isInteger(tabId) || processingTabs.has(tabId) || saveLocks.has(tabId)) throw new Error('Application is busy or unavailable');
  saveLocks.add(tabId);
  try {
    const { run, field } = await guardedDraftField(message, { allowSaveLock: true });
    const applied = await applyReviewedField({
      tabId, frameId: message.frameId, applicationId: run.startedAt, field, suggestion: null, message: { ...message, answer }, approvalGuard: null,
      assertAuthority: () => assertRunSiteAuthority(tabId, run),
    });
    categorizeRun(run, applied.inspection, applied.validation);
    return { ok: true, run: await saveRun(run) };
  } finally {
    saveLocks.delete(tabId);
  }
}

async function rewriteAnswer(message, inlineContext = null) {
  const draft = requiredBoundedText(message.draft, 'Draft answer', MAX_DRAFT_CHARS);
  const instruction = requiredBoundedText(message.instruction, 'Rewrite instruction', MAX_REWRITE_INSTRUCTION_CHARS);
  const { suggestion, field } = inlineContext || await guardedDraftField(message);
  const settings = await getSettings();
  const sessionId = inlineContext?.session?.attachedRun?.applicationId
    ? String(message.tabId) + ':' + inlineContext.session.attachedRun.applicationId
    : String(message.tabId) + ':' + ((await getRun(message.tabId))?.startedAt || message.sessionId || 'standalone');
  const traceContext = createPhoenixTrace(sessionId, {'phoenix.action': 'answer_rewrite', 'application.field_id': field.id});
  await persistPhoenixAction(traceContext, 'answer_rewrite', sessionId, {'application.field_id': field.id});
  void tracePhoenixEvent('answer_rewrite', {'application.field_id': field.id}, sessionId, {traceContext, root: true, defer: true, input: {question: field.label, draft, instruction}});
  const apiKey = await getApiKey(settings.aiProvider);
  if (!apiKey) {
    void tracePhoenixEvent('answer_rewrite', {'ai.skipped': true, 'ai.reason': 'missing_provider_key'}, sessionId, {traceContext, root: true, output: {retained: false, reason: 'missing_provider_key'}});
    void clearPhoenixAction(traceContext);
    throw new Error(missingProviderKeyMessage(settings.aiProvider));
  }
  const records = await rewriteEvidence(suggestion, message);
  let rewritten;
  let traceOutcome = {retained: false, reason: 'incomplete'};
  try {
    rewritten = await callAnswerRewriter({
      apiKey,
      question: field.label,
      draft,
      instruction,
      records,
      page: inlineContext ? inlineContext.session.jobContext || {} : (await getRun(message.tabId))?.jobContext || {},
    }, { provider: settings.aiProvider, model: settings.aiModel, sessionId, traceContext });
    const answer = requiredBoundedText(rewritten.answer, 'Rewritten answer', MAX_DRAFT_CHARS);
    traceOutcome = {retained: true};
    void tracePhoenixEvent('answer_rewrite_result', {'application.field_id': field.id, 'ai.retained': true}, sessionId, {traceContext, output: {...rewritten, retained: true}});
    return { ok: true, answer };
  } catch (error) {
    traceOutcome = {retained: false, reason: error.message};
    void tracePhoenixEvent('answer_rewrite_result', {'application.field_id': field.id, 'ai.validation_error': error.message, 'ai.retained': false}, sessionId, {traceContext, statusCode: 'ERROR', statusMessage: error.message, output: {retained: false, reason: error.message}});
    throw error;
  } finally {
    void tracePhoenixEvent('answer_rewrite', {'application.field_id': field.id, 'ai.retained': Boolean(traceOutcome.retained)}, sessionId, {traceContext, root: true, statusCode: traceOutcome.retained ? 'OK' : 'ERROR', statusMessage: traceOutcome.reason || '', output: traceOutcome});
    void clearPhoenixAction(traceContext);
  }
}

function savedClosingEvidence(field, datasource) {
  if (field.type !== 'textarea' && !/why|interest|motivation|cover letter|additional information/i.test(field.label || '')) return [];
  return (datasource.coverMessages || []).slice(0, 10).map(message => ({
    key: `cover:${message.id}`, question: message.label, answer: message.body,
    provenance: 'saved cover answer', confirmationState: 'confirmed', sensitivity: 'safe',
  }));
}

async function generateFieldDrafts({ field, inspection, jobContext, datasource, records, settings, apiKey, sessionId = '', traceContext = null }) {
  const pageRecords = (inspection?.fields || [])
    .filter((item) => item.currentValue && readableQuestion(item))
    .map((item) => ({ key: `page:${item.id}`, question: item.label, answer: item.currentValue, provenance: 'current application page', sensitivity: inferSensitivity(item.label, item.id) }));
  return callAnswerSuggestions({
    apiKey,
    field,
    page: jobContext,
    records: [...savedClosingEvidence(field, datasource), ...rankSuggestionEvidence(field, [...records, ...profileEvidenceRecords(datasource.profile), ...pageRecords], {limit:40})],
  }, { provider: settings.aiProvider, model: settings.aiModel, sessionId, traceContext });
}

async function generateSuggestions(message) {
  const jobDescription = message.jobDescription == null || (typeof message.jobDescription === 'string' && !message.jobDescription.trim())
    ? ''
    : requiredBoundedText(message.jobDescription, 'Job description', 16_000);
  const { run, field, authority } = await guardedDraftField(message);
  if (!readableQuestion(field)) throw new Error('The form question is unclear. Use Show on page and enter the answer manually.');
  const settings = await getSettings();
  const sessionId = String(message.tabId) + ':' + run.startedAt;
  const traceContext = createPhoenixTrace(sessionId, {'phoenix.action': 'answer_suggestions', 'application.field_id': field.id});
  await persistPhoenixAction(traceContext, 'answer_suggestions', sessionId, {'application.field_id': field.id});
  void tracePhoenixEvent('answer_suggestions', {'application.field_id': field.id}, sessionId, {traceContext, root: true, defer: true, input: {field, jobDescription}});
  const apiKey = await getApiKey(settings.aiProvider);
  if (!apiKey) {
    void tracePhoenixEvent('answer_suggestions', {'ai.skipped': true, 'ai.reason': 'missing_provider_key'}, sessionId, {traceContext, root: true, output: {retained: false, reason: 'missing_provider_key'}});
    void clearPhoenixAction(traceContext);
    throw new Error(missingProviderKeyMessage(settings.aiProvider));
  }
  const [records, datasource, inspected] = await Promise.all([getRecords(), getDatasource(), sendToFrame(message.tabId, message.frameId, { type: 'JOB_APP_INSPECT' }, authority)]);
  const jobContext = mergeJobContext(run.jobContext, inspected.inspection?.page);
  if (jobDescription) jobContext.jobDescription = jobDescription;
  const snapshot = suggestionRequestSnapshot(run, field, inspected.inspection, datasource, settings, jobContext);
  let traceOutcome = {retained: false, reason: 'incomplete'};
  try {
    const generated = await generateFieldDrafts({ field, inspection: inspected.inspection, jobContext, datasource, records, settings, apiKey, sessionId, traceContext });
    const validation = await sendToFrame(message.tabId, message.frameId, { type: 'JOB_APP_VALIDATE' }, authority);
    const current = await currentSuggestionDestination(message.tabId, snapshot);
    if (!current) throw new Error('The page or supporting evidence changed. Generate again.');
    const updated = await mutateRun(message.tabId, (run) => {
      if (!sameSuggestionRun(run, snapshot) || run.revision !== current.run.revision) return false;
      run.jobContext = jobContext;
      run.generatedSuggestions = run.generatedSuggestions || {};
      run.generatedSuggestions[field.id] = {
        tabId: message.tabId, frameId: message.frameId, applicationId: run.startedAt, pageSignature: run.pageSignature,
        field, suggestions: generated.suggestions, missingContext: generated.missingContext, snapshot,
      };
      categorizeRun(run, current.inspection, validation?.validation || {});
    });
    if (!updated) throw new Error('The page or supporting evidence changed. Generate again.');
    traceOutcome = {retained: true, suggestionCount: generated.suggestions?.length || 0};
    void tracePhoenixEvent('answer_suggestions_result', {'application.field_id': field.id, 'ai.suggestion_count': generated.suggestions?.length || 0, 'ai.retained': true}, sessionId, {traceContext, output: {...generated, retained: true}});
    return { ok: true, run: updated };
  } catch (error) {
    traceOutcome = {retained: false, reason: error.message};
    void tracePhoenixEvent('answer_suggestions_result', {'application.field_id': field.id, 'ai.validation_error': error.message, 'ai.retained': false}, sessionId, {traceContext, statusCode: 'ERROR', statusMessage: error.message, output: {retained: false, reason: error.message}});
    throw error;
  } finally {
    void tracePhoenixEvent('answer_suggestions', {'application.field_id': field.id, 'ai.retained': Boolean(traceOutcome.retained)}, sessionId, {traceContext, root: true, statusCode: traceOutcome.retained ? 'OK' : 'ERROR', statusMessage: traceOutcome.reason || '', output: traceOutcome});
    void clearPhoenixAction(traceContext);
  }
}

function hasBlockingIssues(run, validation) {
  return Boolean(run.actionRequired.length || !validation.ok);
}

async function processPage(tabId, { autoAdvance, selectedDestination = null } = { autoAdvance: false }) {
  if (processingTabs.has(tabId)) return getRun(tabId);
  processingTabs.add(tabId);
  try {
    let run = await getRun(tabId);
    if (!run || run.status !== 'running') return run;
    if (run.siteRevision == null) run.siteRevision = siteRevision(tabId);
    try { await assertTabFormActive(tabId, run.siteRevision); }
    catch (error) {
      if ([DISABLED_SITE_REASON, INACTIVE_FORM_REASON].includes(error.message)) { await removeRun(tabId); return null; }
      throw error;
    }
    if (run.pageNumber > MAX_PAGES) {
      run.status = 'waiting_user';
      run.waitingFor = 'page_limit_exceeded';
      run.actionRequired = [{ reason: 'The application exceeded the 20-page automatic limit.' }];
      run.nextAction = null;
      return await saveRun(run);
    }

    const [records, coverMessages, datasource, settings] = await Promise.all([
      getRecords(),
      getCoverMessages(),
      getDatasource(),
      getSettings(),
    ]);
    const discovery = await discoverApplicationFrame(tabId, () => assertRunSiteAuthority(tabId, run), selectedDestination || run.selectedDestination, String(tabId) + ':' + run.startedAt);
    if (discovery.errorCode) return await saveRun(pauseForFrame(run, discovery));
    updateSelectedFrame(tabId, run, discovery);
    const currentTab = await tabForSite(tabId);
    try {
      const url = new URL(currentTab?.url || '');
      run.formOrigin = {domain: url.hostname, pathname: url.pathname};
    } catch { /* site guard already validated the tab */ }
    await assertTabFormActive(tabId, run.siteRevision);
    const processed = await applyPageDecisions(
      tabId,
      run,
      discovery.inspection,
      records,
      coverMessages,
      datasource.profile,
      datasource.datasourceMeta?.updatedAt || '',
      settings.voteAutofillEnabled,
      {pass: 0, deadline: Date.now() + 8000},
      {enabled: settings.typesafeEnabled && Boolean(await getTypeSafeApiKey()), allowSensitive: settings.typesafeAutofillSensitive},
    );
    run = processed.run;
    const inspection = processed.inspection;
    const validation = processed.validation;

    if (run.waitingFor === 'navigation_not_detected') return await saveRun(run);
    if (hasBlockingIssues(run, validation)) {
      run.status = 'waiting_user';
      run.waitingFor = run.actionRequired[0]?.reason || 'invalid_field';
      run.waitingLabel = await focusFirstProblem(tabId, run, inspection, validation);
      run.nextAction = null;
      return await saveRun(run);
    }

    const nextActions = inspection.actions.filter((action) => action.kind === 'next');
    const submitActions = inspection.actions.filter((action) => action.kind === 'submit');
    if (nextActions.length === 1) {
      if (run.pageNumber >= MAX_PAGES) {
        run.status = 'waiting_user';
        run.waitingFor = 'page_limit_exceeded';
        run.actionRequired = [{ reason: 'The application reached the 20-page automatic limit.' }];
        run.nextAction = null;
        return await saveRun(run);
      }
      run.nextAction = nextActions[0];
      run.waitingFor = null;
      run.waitingLabel = null;
      if (!autoAdvance) {
        run.status = 'page_ready';
        return await saveRun(run);
      }
      const clicked = await sendToApplicationFrame(tabId, run, {
        type: 'JOB_APP_CLICK_NEXT',
        actionId: nextActions[0].id,
      });
      if (!clicked?.ok) {
        run.status = 'waiting_user';
        run.waitingFor = 'ambiguous_navigation';
        run.actionRequired = [{ reason: clicked?.error || 'The Next control could not be activated' }];
        run.nextAction = null;
        return await saveRun(run);
      }
      run.pageNumber += 1;
      run.status = 'running';
      run.lastAction = 'next';
      return await saveRun(run);
    }
    if (submitActions.length === 1 && validation.ok) {
      run.status = 'ready_for_user_submit';
      run.nextAction = null;
      run.waitingFor = null;
      run.waitingLabel = null;
      return await saveRun(run);
    }

    run.status = 'waiting_user';
    run.waitingFor = submitActions.length === 0 ? 'no_submit_control' : 'ambiguous_navigation';
    run.actionRequired = [{ reason: run.waitingFor }];
    run.nextAction = null;
    return await saveRun(run);
  } catch (error) {
    if (error.frameDiscovery) {
      const currentRun = await getRun(tabId);
      if (!currentRun) return null;
      return await saveRun(pauseForFrame(currentRun, error.frameDiscovery));
    }
    const run = await getRun(tabId);
    if (!run) return null;
    if (run.lastAction === 'next') {
      run.status = 'waiting_user';
      run.waitingFor = 'navigation_not_detected';
      run.actionRequired = [{ reason: 'The page could not be inspected after Next/Continue.' }];
      run.nextAction = null;
      return await saveRun(run);
    }
    run.status = 'waiting_user';
    run.waitingFor = 'extension_error';
    run.actionRequired = [{ reason: error.message }];
    run.nextAction = null;
    return await saveRun(run);
  } finally {
    processingTabs.delete(tabId);
    await scheduleAi(tabId).catch(() => {});
  }
}

async function startRun(tabId) {
  await invalidateInlineSessions(tabId);
  await assertTabSiteEnabled(tabId);
  const tab = await tabForSite(tabId);
  const current = await getRun(tabId);
  if (current && ACTIVE_RUN_STATUSES.has(current.status)) {
    await notifySiteState(tabId, true);
    if (current.status !== 'running') return current;
    const settings = await getSettings();
    return processPage(tabId, { autoAdvance: settings.autoAdvancePages });
  }
  const run = await saveRun(nowRun(tabId, tab));
  await notifySiteState(tabId, true);
  const settings = await getSettings();
  return processPage(tabId, { autoAdvance: settings.autoAdvancePages });
}

async function checkPage(tabId) {
  let run = await getRun(tabId);
  if (!run) return startRun(tabId);
  run.status = 'running';
  run.waitingFor = null;
  run.waitingLabel = null;
  run.nextAction = null;
  await saveRun(run);
  return processPage(tabId, { autoAdvance: false });
}

async function advancePage(tabId) {
  let run = await checkPage(tabId);
  if (!run || run.status !== 'page_ready' || !run.nextAction) return { ok: false, error: 'The current page is not ready to advance', run };
  const previous = structuredClone(run);
  const nextAction = run.nextAction;
  run.pageNumber += 1;
  run.status = 'running';
  run.lastAction = 'next';
  run.waitingFor = null;
  run.waitingLabel = null;
  run.nextAction = null;
  // Persist the transition before clicking. A full-document navigation can
  // start the new content script before the click response reaches us.
  run = await saveRun(run);
  await notifySiteState(tabId, true);
  let clicked;
  try {
    clicked = await sendToApplicationFrame(tabId, run, {
      type: 'JOB_APP_CLICK_NEXT',
      actionId: nextAction.id,
    });
  } catch (error) {
    if (!error.frameDiscovery) throw error;
    return { ok: false, error: error.message, run: await saveRun(pauseForFrame(previous, error.frameDiscovery)) };
  }
  if (!clicked?.ok) {
    previous.status = 'waiting_user';
    previous.waitingFor = 'ambiguous_navigation';
    previous.actionRequired = [{ reason: clicked?.error || 'The Next control could not be activated' }];
    previous.nextAction = null;
    return { ok: false, error: previous.actionRequired[0].reason, run: await saveRun(previous) };
  }
  return { ok: true, run };
}

async function focusRunField(tabId, fieldId) {
  if (!fieldId) throw new Error('A fieldId is required');
  const run = await getRun(tabId);
  if (!run) return { ok: false, run: null };
  if (!Number.isInteger(run.frame?.frameId)) return {ok: false, error: 'Select an application form before focusing a field.', run};
  const discovery = await discoverApplicationFrame(tabId, () => assertRunSiteAuthority(tabId, run), run.frame?.destination ? {...run.frame.destination, frameId: run.frame.frameId} : run.selectedDestination, String(tabId) + ':' + run.startedAt);
  if (discovery.errorCode) return { ok: false, run: await saveRun(pauseForFrame(run, discovery)) };
  updateSelectedFrame(tabId, run, discovery);
  try {
    const focused = await sendToApplicationFrame(tabId, run, { type: 'JOB_APP_FOCUS', fieldId });
    return { ok: Boolean(focused?.ok), run: await saveRun(run) };
  } catch (error) {
    if (!error.frameDiscovery) throw error;
    return { ok: false, error: error.message, run: await saveRun(pauseForFrame(run, error.frameDiscovery)) };
  }
}

function removeCandidateFromRun(run, fieldId, sourceKey) {
  const suggestion = run?.suggestions?.[fieldId];
  if (!suggestion) return;
  suggestion.candidates = (suggestion.candidates || []).filter((candidate) => !sourceKeysForCandidate(candidate).includes(sourceKey));
  if (suggestion.candidates.length) return;
  delete run.suggestions[fieldId];
  for (const item of [...(run.actionRequired || []), ...(run.optionalUnresolved || [])]) {
    if (item?.fieldId !== fieldId) continue;
    delete item.suggestion;
    item.reason = 'No validated answer is available';
  }
}

async function updateSavedAnswerFeedback(message, action) {
  const tabId = message.tabId;
  const fieldId = String(message.fieldId || '');
  const sourceKey = String(message.sourceKey || '');
  if (!Number.isInteger(tabId) || !fieldId || !sourceKey) throw new Error('The saved answer is unavailable');
  const run = await getRun(tabId);
  const suggestion = run?.suggestions?.[fieldId];
  const candidate = suggestion?.candidates?.find((item) => item.kind !== 'draft' && item.kind !== 'planner' && sourceKeysForCandidate(item).length === 1 && sourceKeysForCandidate(item)[0] === sourceKey);
  if (!candidate) throw new Error('The saved answer is no longer available for this field. Check the page again.');
  const targetKey = suggestionTargetKey(suggestion.field);
  if (action === 'suppress' && !targetKey) throw new Error('The destination question is unavailable');
  datasourceWriteChain = datasourceWriteChain.catch(() => {}).then(async () => {
    const state = await getDatasource();
    const record = state.answerRecords.find((item) => item.key === sourceKey);
    if (!record) throw new Error('The saved answer no longer exists.');
    const now = new Date().toISOString();
    const answerRecords = action === 'delete'
      ? state.answerRecords.filter((item) => item.key !== sourceKey)
      : state.answerRecords.map((item) => item.key === sourceKey
        ? { ...item, suppressedFor: [...new Set([...(item.suppressedFor || []), targetKey])], updatedAt: now }
        : item);
    return saveDatasource({
      ...state,
      answerRecords,
      datasourceMeta: { ...(state.datasourceMeta || {}), schemaVersion: state.schemaVersion, updatedAt: now },
    });
  });
  await datasourceWriteChain;
  removeCandidateFromRun(run, fieldId, sourceKey);
  return { ok: true, run: await saveRun(run), datasource: await datasourceSummary() };
}

async function saveAnswers(tabId) {
  if (saveLocks.has(tabId)) return { ok: false, error: 'Answer saving is already in progress' };
  const finishSave = beginSaveOperation(tabId);
  let run = null;
  try {
    run = await getRun(tabId);
    if (!run || !SAVABLE_RUN_STATUSES.has(run.status) || !Number.isInteger(run.frame?.frameId)) {
      return { ok: false, error: 'The current page is not ready to save answers' };
    }
    const discovery = await discoverApplicationFrame(tabId, () => assertRunSiteAuthority(tabId, run), run.frame?.destination ? {...run.frame.destination, frameId: run.frame.frameId} : run.selectedDestination, String(tabId) + ':' + run.startedAt);
    if (discovery.errorCode) return { ok: false, error: discovery.reason, run: await saveRun(pauseForFrame(run, discovery)) };
    updateSelectedFrame(tabId, run, discovery);
    const inspection = discovery.inspection;
    const captured = await sendToApplicationFrame(tabId, run, { type: 'JOB_APP_CAPTURE', finalize: true });
    if (!captured?.ok) throw new Error(captured?.error || 'Could not read the current form values.');
    return await saveCapturedAnswers(run, inspection, captured.records || [], () => assertRunSiteAuthority(tabId, run), { promote: true });
  } catch (error) {
    if (!error.frameDiscovery) throw error;
    return { ok: false, error: error.message, run: await saveRun(pauseForFrame(run, error.frameDiscovery)) };
  } finally {
    finishSave();
  }
}

async function saveCapturedAnswers(run, inspection, records, assertAuthority = null, { promote = false } = {}) {
  assertAuthority?.();
  const result = await recordPageCapture(run, inspection, records, { promote, assertAuthority });
  assertAuthority?.();
  const learning = await queueLearningReview(records, String(run.tabId) + ':' + run.startedAt);
  run = result.run;
  if (run.status === 'ready_for_user_submit') {
    run.status = 'answers_saved';
    run.waitingFor = null;
    run.waitingLabel = null;
  }
  return { ok: true, run: await saveRun(run), ...result.stats, learningQueued: learning.queued, learningError: learning.error };
}

async function saveFinalSubmission(message, sender, assertAuthority = null) {
  const tabId = sender?.tab?.id;
  const frameId = Number.isInteger(sender?.frameId) ? sender.frameId : 0;
  if (!Number.isInteger(tabId) || !Array.isArray(message.records)) return { ok: false, error: 'The submitted application snapshot is unavailable' };
  const acceptedRun = await getRun(tabId);
  assertAuthority?.();
  if (!matchesFinalSubmission(acceptedRun, message, sender, frameId)) {
    return { ok: false, error: 'The submitted application is no longer active' };
  }
  // A native submit may navigate while a manual checkpoint is still capturing.
  // Keep the validated state so that capture failure cannot discard this snapshot.
  const finalRun = structuredClone(acceptedRun);
  while (saveOperations.has(tabId)) {
    await saveOperations.get(tabId);
    const currentRun = await getRun(tabId);
    if (!currentRun || currentRun.startedAt !== finalRun.startedAt) {
      return { ok: false, error: 'The submitted application is no longer active' };
    }
  }
  const finishSave = beginSaveOperation(tabId);
  try {
    assertAuthority?.();
    const previousPage = finalRun.pages?.find((page) => page.pageNumber === finalRun.pageNumber);
    const page = message.page && typeof message.page === 'object' ? message.page : (previousPage?.page || finalRun.jobContext || {});
    return await saveCapturedAnswers(finalRun, { page }, message.records, assertAuthority, { promote: true });
  } finally {
    finishSave();
  }
}

function matchesFinalSubmission(run, message, sender, frameId) {
  if (!run || !SAVABLE_RUN_STATUSES.has(run.status)
    || run.frame?.frameId !== frameId || message.applicationId !== run.startedAt) return false;
  if (!sender.url) return true;
  try {
    const url = new URL(sender.url);
    return (!run.frame.domain || url.hostname === run.frame.domain)
      && (!run.frame.pathname || url.pathname === run.frame.pathname);
  } catch {
    return false;
  }
}

function beginSaveOperation(tabId) {
  saveLocks.add(tabId);
  let resolve;
  const completion = new Promise((done) => { resolve = done; });
  saveOperations.set(tabId, completion);
  return () => {
    saveLocks.delete(tabId);
    resolve();
    if (saveOperations.get(tabId) === completion) saveOperations.delete(tabId);
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'JOB_APP_SITE_STATUS') {
    (async () => {
      const tabHint = sender?.tab ? {...sender.tab, ...(sender.url ? {url: sender.url} : {}), ...(sender.documentId ? {documentId: sender.documentId} : {})} : sender;
      const state = await siteStateForTab(sender?.tab?.id, tabHint);
      const run = Number.isInteger(sender?.tab?.id) ? await getRun(sender.tab.id) : null;
      const tab = await tabForSite(sender?.tab?.id, tabHint);
      return siteStateReply({...state, sessionActive: formSessionMatchesTab(run, tab)});
    })()
      .then((state) => sendResponse({ ok: true, ...state }))
      .catch((error) => sendResponse({ ok: false, enabled: false, supported: false, error: error.message }));
    return true;
  }
  if (message?.type === 'JOB_INLINE_EDIT_IN_PANEL') {
    try {
      const request = {...message, requestId: message.requestId || crypto.randomUUID()};
      const origin = inlineOrigin(request, sender);
      // Chrome 116+ only; preserve Chrome 114 support. Invoke directly during the
      // content-script user gesture, before storage/inspection awaits consume it.
      // https://developer.chrome.com/docs/extensions/reference/api/sidePanel
      (async () => {
        let opening;
        try {
          opening = typeof chrome.sidePanel?.open === 'function'
            ? Promise.resolve(chrome.sidePanel.open({tabId: origin.tabId})).then(() => null, () => PANEL_OPEN_FALLBACK)
            : Promise.resolve(PANEL_OPEN_FALLBACK);
        } catch { opening = Promise.resolve(PANEL_OPEN_FALLBACK); }
        await assertTabFormActive(origin.tabId, sender);
        return handoffInlineField(request, sender, opening);
      })().then(sendResponse).catch(error => sendResponse({ok: false, error: error.message}));
    } catch (error) { sendResponse({ok: false, error: error.message}); }
    return true;
  }
  if (['JOB_INLINE_QUERY', 'JOB_INLINE_SEARCH', 'JOB_INLINE_SEMANTIC_SEARCH', 'JOB_INLINE_GENERATE', 'JOB_INLINE_ACCEPT', 'JOB_INLINE_CANCEL'].includes(message?.type)) {
    (async () => {
      await assertTabFormActive(sender?.tab?.id, sender);
      if (message.type === 'JOB_INLINE_QUERY') return queryInlineField(message, sender);
      if (message.type === 'JOB_INLINE_SEARCH') return searchInlineField(message, sender);
      if (message.type === 'JOB_INLINE_SEMANTIC_SEARCH') return semanticSearchInlineField(message, sender);
      if (message.type === 'JOB_INLINE_GENERATE') return generateInlineField(message, sender);
      if (message.type === 'JOB_INLINE_ACCEPT') return acceptInlineField(message, sender);
      const origin = inlineOrigin(message, sender);
      const session = await writeInlineSessions(sessions => sessions[`${origin.tabId}:${origin.frameId}`]);
      if (!session || session.sessionId !== message.sessionId || Object.keys(origin).some(key => session[key] !== origin[key])) throw new Error('Inline session expired or destination changed');
      await mutateInlineSession(origin.tabId, origin.frameId, message.sessionId, () => null);
      return inlineReply(session, message.requestId, {candidates: [], generatedSuggestion: null});
    })().then(sendResponse).catch(error => sendResponse({ok: false,
      sessionId: typeof message.sessionId === 'string' && message.sessionId.length <= 200 ? message.sessionId : null,
      requestId: typeof message.requestId === 'string' && message.requestId.length <= 200 ? message.requestId : null,
      field: null, candidates: [], generatedSuggestion: null, error: error.message}));
    return true;
  }
  if (message?.type === 'JOB_APP_REVALIDATE') {
    (async()=>{
      const tabId=sender?.tab?.id;const run=Number.isInteger(tabId)?await getRun(tabId):null;
      await assertTabFormActive(tabId, sender);
      if(!run || message.applicationId!==run.startedAt || (sender.frameId??0)!==run.frame?.frameId) return {ok:false};
      if(sender.url){const url=new URL(sender.url);if(url.hostname!==run.frame.domain || (run.frame.pathname && url.pathname!==run.frame.pathname))return {ok:false};}
      return {ok:true,run:await validatePageOnly(tabId)};
    })().then(sendResponse).catch(error=>sendResponse({ok:false,error:error.message}));return true;
  }
  if (message?.type === 'JOB_APP_FINAL_SUBMISSION') {
    (async () => {
      await assertTabSiteEnabled(sender?.tab?.id, sender?.tab);
      return saveFinalSubmission(message, sender, siteAuthority(sender?.tab?.id));
    })()
      .then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'JOB_APP_LEARN' || message?.type === 'JOB_APP_LEARNING_STATUS') {
    (async () => {
      const tabId = sender?.tab?.id;
      await assertTabSiteEnabled(tabId, sender);
      const run = tabId ? await getRun(tabId) : null;
      if (!run || ![...ACTIVE_RUN_STATUSES, 'answers_saved'].includes(run.status) || run.frame?.frameId !== (sender.frameId ?? 0)) return { ok: false };
      if (sender.url) {
        const url = new URL(sender.url);
        if (run.frame.domain && url.hostname !== run.frame.domain) return { ok: false };
        if (run.frame.pathname && url.pathname !== run.frame.pathname) {
          const discovery = await discoverApplicationFrame(tabId, () => assertRunSiteAuthority(tabId, run), run.frame?.destination ? {...run.frame.destination, frameId: run.frame.frameId} : run.selectedDestination, String(tabId) + ':' + run.startedAt);
          if (discovery.errorCode || discovery.frameId !== (sender.frameId ?? 0) || discovery.context.pathname !== url.pathname) return { ok: false };
          updateSelectedFrame(tabId, run, discovery);
          if (run.lastAction !== 'next') {
            run.status = 'waiting_user';
            run.waitingFor = 'page_changed';
            run.nextAction = null;
            run.pageNumber += 1;
          }
          await saveRun(run);
        }
      }
      if (message.type === 'JOB_APP_LEARNING_STATUS') return { ok: true, applicationId: run.startedAt };
      if (message.applicationId !== run.startedAt || !Array.isArray(message.records)) return { ok: false };
      const saved = await persistLearnedRecords(message.records, run, { promote: true, auto: true, assertAuthority: () => assertRunSiteAuthority(tabId, run) });
      void scheduleAi(tabId).catch(() => {});
      return { ok: true, savedCount: saved.stats.savedCount, undoAvailable: Boolean(saved.state.learningUndo) };
    })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'JOB_APP_FORM_SELECTED') {
    acceptFormSelection(message, sender).then(sendResponse).catch(error => sendResponse({ok: false, error: error.message}));
    return true;
  }
  if (message?.type === 'JOB_APP_NAVIGATED') {
    const tabId = sender?.tab?.id;
    (async () => {
      await assertTabSiteEnabled(tabId, sender?.tab);
      if (Number.isInteger(tabId)) await cancelFormSelection(tabId);
      if (Number.isInteger(tabId)) await invalidateInlineSessions(tabId, Number.isInteger(sender.frameId) ? sender.frameId : 0);
      const run = tabId ? await getRun(tabId) : null;
      const senderFrameId = Number.isInteger(sender?.frameId) ? sender.frameId : 0;
      if (!run || !FORM_SESSION_STATUSES.has(run.status)) return { ok: true, run };
      if (!Number.isInteger(run.frame?.frameId) || run.frame.frameId !== senderFrameId) return { ok: true, run };
      if (run.status !== 'running' || run.lastAction !== 'next') {
        return { ok: true, run: await validatePageOnly(tabId, {refreshDestination: true}) };
      }
      const settings = await getSettings();
      return { ok: true, run: await processPage(tabId, { autoAdvance: settings.autoAdvancePages }) };
    })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (![
    'JOB_INLINE_PANEL_STATE',
    'JOB_SITE_CONTROL_STATE',
    'JOB_SITE_SET_DISABLED',
    'JOB_SITE_REMOVE_DISABLED',
    'JOB_RUN_APPROVE_SUGGESTION',
    'JOB_RUN_APPLY_DRAFT',
    'JOB_RUN_REWRITE_ANSWER',
    'JOB_RUN_GENERATE_SUGGESTIONS',
    'JOB_RUN_SELECT_FORM',
    'JOB_RUN_START',
    'JOB_RUN_CHECK_PAGE',
    'JOB_RUN_ADVANCE_PAGE',
    'JOB_RUN_FOCUS_FIELD',
    'JOB_RUN_SAVE_ANSWERS',
    'JOB_RUN_VALIDATE_PAGE',
    'JOB_RUN_RETRY_AI',
    'JOB_RUN_SELECT_EMPLOYMENT',
    'JOB_RUN_SEARCH_ANSWERS',
    'JOB_RUN_SEMANTIC_SEARCH',
    'JOB_RUN_STATE',
    'JOB_RUN_DEBUG_CAPTURE',
    'JOB_DATASOURCE_STATE',
    'JOB_DATASOURCE_UNDO_LAST_AUTOSAVE',
    'JOB_DATASOURCE_EXPORT',
    'JOB_DATASOURCE_IMPORT',
    'JOB_DATASOURCE_CORRECT',
    'JOB_DATASOURCE_DISMISS_CHANGE',
    'JOB_DATASOURCE_SUPPRESS_ANSWER',
    'JOB_DATASOURCE_DELETE_ANSWER',
    'JOB_DATASOURCE_PROFILE_UPDATE',
    'JOB_LEARNING_INBOX_RESOLVE',
  ].includes(message?.type)) return false;

  (async () => {
    if (!chrome.runtime.id || sender?.id !== chrome.runtime.id || sender?.tab
      || typeof sender?.url !== 'string' || !sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`)) {
      throw new Error('This action must originate in the extension panel');
    }
    if (message.type === 'JOB_SITE_CONTROL_STATE') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const site = await siteStateForTab(tab?.id, tab);
      return { ok: true, site: siteStateReply(site) };
    }
    if (message.type === 'JOB_SITE_SET_DISABLED') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tab?.id;
      if (!Number.isInteger(tabId) || typeof message.disabled !== 'boolean') throw new Error('A current site and desired state are required.');
      return { ok: true, site: await updateSiteDisabled(tabId, message.disabled) };
    }
    if (message.type === 'JOB_SITE_REMOVE_DISABLED') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const normalized = normalizeHostname(message.hostname);
      if (!normalized) throw new Error('A valid hostname is required.');
      const current = await siteStateForTab(tab?.id, tab);
      if (current.hostname === normalized && current.disabled) {
        return { ok: true, site: await updateSiteDisabled(tab.id, false) };
      }
      const disabledHostnames = await removeDisabledHostname(normalized);
      return { ok: true, site: siteStateReply({ ...current, disabledHostnames }) };
    }
    if (message.type === 'JOB_INLINE_PANEL_STATE') return inlinePanelState(message);
    if (message.inlineSessionId) return inlinePanelAction(message);
    if (['JOB_DATASOURCE_SUPPRESS_ANSWER', 'JOB_DATASOURCE_DELETE_ANSWER'].includes(message.type)) {
      return updateSavedAnswerFeedback(message, message.type === 'JOB_DATASOURCE_DELETE_ANSWER' ? 'delete' : 'suppress');
    }
    if (['JOB_RUN_APPROVE_SUGGESTION', 'JOB_RUN_APPLY_DRAFT', 'JOB_RUN_REWRITE_ANSWER', 'JOB_RUN_GENERATE_SUGGESTIONS'].includes(message.type)) {
      if (message.type === 'JOB_RUN_APPLY_DRAFT') return applyDraft(message);
      if (message.type === 'JOB_RUN_REWRITE_ANSWER') return rewriteAnswer(message);
      if (message.type === 'JOB_RUN_GENERATE_SUGGESTIONS') return generateSuggestions(message);
      return approveSuggestion(message);
    }
    if (message.type === 'JOB_DATASOURCE_STATE') return { ok: true, datasource: await datasourceSummary() };
    if (message.type === 'JOB_DATASOURCE_UNDO_LAST_AUTOSAVE') { await undoLastAutoLearn(); return { ok: true, datasource: await datasourceSummary() }; }
    if (message.type === 'JOB_DATASOURCE_EXPORT') return { ok: true, backup: serializeDatasourceBackup(await getDatasource()) };
    if (message.type === 'JOB_DATASOURCE_IMPORT') {
      await importDatasourceBackup(message.backup);
      return { ok: true, datasource: await datasourceSummary() };
    }
    if (message.type === 'JOB_DATASOURCE_CORRECT') {
      return { ok: true, datasource: await correctDatasourceRecord(message.key, message.answer) };
    }
    if (message.type === 'JOB_DATASOURCE_DISMISS_CHANGE') {
      return { ok: true, datasource: await dismissDatasourceChange(message.key) };
    }
    if (message.type === 'JOB_DATASOURCE_PROFILE_UPDATE') {
      return { ok: true, datasource: await updateDatasourceProfile(message.profile || {}) };
    }
    if (message.type === 'JOB_LEARNING_INBOX_RESOLVE') {
      return { ok: true, datasource: await resolveLearningInbox(message.id, message.action) };
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = message.tabId || tab?.id;
    if (!tabId) throw new Error('No active browser tab was found');
    const site = await siteStateForTab(tabId, tab);
    if (message.type === 'JOB_RUN_STATE') {
      return { ok: true, run: site.disabled ? null : await getRun(tabId), site: siteStateReply(site) };
    }
    await assertTabSiteEnabled(tabId, null);
    if (message.type === 'JOB_RUN_DEBUG_CAPTURE') return captureDebugCase(tabId, tab);
    if (message.type === 'JOB_RUN_SELECT_FORM') return requestFormSelection(tabId);
    if (message.type === 'JOB_RUN_VALIDATE_PAGE') return { ok: true, run: await validatePageOnly(tabId) };
    if (message.type === 'JOB_RUN_RETRY_AI') { await scheduleAi(tabId, { retry: true }); return { ok: true, run: await getRun(tabId) }; }
    if (message.type === 'JOB_RUN_SELECT_EMPLOYMENT') return selectEmployment(message);
    if (message.type === 'JOB_RUN_SEARCH_ANSWERS') return searchSavedAnswers(message);
    if (message.type === 'JOB_RUN_SEMANTIC_SEARCH') return semanticSearchSavedAnswers(message);
    if (message.type === 'JOB_RUN_FOCUS_FIELD') return focusRunField(tabId, message.fieldId);
    if (message.type === 'JOB_RUN_ADVANCE_PAGE') return advancePage(tabId);
    if (message.type === 'JOB_RUN_SAVE_ANSWERS') return saveAnswers(tabId);
    const run = message.type === 'JOB_RUN_START'
      ? await startRun(tabId)
      : await checkPage(tabId);
    return { ok: true, run };
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'loading') debugSelections.delete(tabId);
  if (changeInfo.url || changeInfo.status === 'loading') activeFormInterpretations.delete(tabId);
  if (changeInfo.url || changeInfo.status === 'loading') for (const key of formInterpretationCache.keys()) if (key.includes(`\"tabId\":${tabId},`)) formInterpretationCache.delete(key);
  if (changeInfo.url || changeInfo.status === 'loading') cancelFormSelection(tabId).catch(() => {});
  if (changeInfo.url || ['loading', 'complete'].includes(changeInfo.status)) invalidateInlineSessions(tabId).catch(() => {});
  if (changeInfo.status !== 'complete') return;
  getRun(tabId)
    .then(async (run) => {
      const site = await siteStateForTab(tabId);
      if (!site.supported || site.disabled) { await removeRun(tabId); return; }
      const tab = await tabForSite(tabId);
      if (run && FORM_SESSION_STATUSES.has(run.status) && !formSessionMatchesTab(run, tab)) {
        await removeRun(tabId);
        return;
      }
      if (run && SAVABLE_RUN_STATUSES.has(run.status)) {
        await validatePageOnly(tabId, {refreshDestination: true});
        return;
      }
      if (run?.status !== 'running' || run.waitingFor === 'operation_interrupted') return;
      run.frame = null;
      await saveRun(run);
      const settings = await getSettings();
      await processPage(tabId, { autoAdvance: settings.autoAdvancePages });
    })
    .catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  debugSelections.delete(tabId);
  activeFormInterpretations.delete(tabId);
  for (const key of formInterpretationCache.keys()) if (key.includes(`\"tabId\":${tabId},`)) formInterpretationCache.delete(key);
  formSelections.delete(tabId);
  invalidateInlineSessions(tabId).catch(() => {});
  removeRun(tabId).catch(() => {});
  siteRevisions.delete(tabId);
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await chrome.storage.session.clear();
  const settings = await chrome.storage.local.get({ autoAdvancePages: false, includeFormScreenshot: true, developerMode: false, [SITE_SETTINGS_KEY]: [] });
  await chrome.storage.local.set({
    autoAdvancePages: Boolean(settings.autoAdvancePages),
    includeFormScreenshot: settings.includeFormScreenshot !== false,
    developerMode: settings.developerMode === true,
    [SITE_SETTINGS_KEY]: normalizeHostnames(settings[SITE_SETTINGS_KEY]),
  });
  let datasourceReady = false;
  try {
    await initializeDatasource();
    datasourceReady = true;
  } catch {
    // Keep legacy keys intact if migration or the empty-profile seed cannot be completed.
  }
  if (datasourceReady) {
    await chrome.storage.local.remove([
      'sheetUrl',
      'answerSource',
      'lastSyncedAt',
      'pendingLearnedAnswers',
    ]);
  }
  if (chrome.storage.local.setAccessLevel) {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  }
});

async function ensurePhoenixDelivery() {
  try {
    if (chrome.alarms?.create) chrome.alarms.create('phoenix-trace-retry', {periodInMinutes: 1});
    await recoverPhoenixActions();
    await flushPhoenixQueue();
  } catch { /* tracing delivery is independent of form filling */ }
}
if (chrome.alarms?.onAlarm?.addListener) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === 'phoenix-trace-retry') flushPhoenixQueue().catch(() => {});
  });
}
if (chrome.storage?.onChanged?.addListener) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.developerMode && changes.developerMode.newValue !== true) {
      debugSelections.clear();
      for (const tabId of formSelections.keys()) if (formSelections.get(tabId)?.debug) cancelFormSelection(tabId).catch(() => {});
    }
    if (area === 'local' && ((changes.phoenixTracing && changes.phoenixTracing.newValue !== false)
      || changes.developerMode?.newValue === true)) flushPhoenixQueue().catch(() => {});
  });
}
void ensurePhoenixDelivery();

function resolveEmploymentFields(run, fields, profile) {
  const employers = profile.employment || [];
  run.employmentMappings ||= {};
  const sections = [...new Set(fields.filter(field => field.entityType === 'employment').map(field => field.entityId).filter(Boolean))];
  run.employmentChoices = [];
  const sectionMappings = {};
  for (const sectionId of sections) {
    const mappingKey = `${run.pageSignature}:${sectionId}`;
    let employmentId = run.employmentMappings[mappingKey];
    if (!employers.some(entry => entry.id === employmentId)) employmentId = null;
    if (!employmentId) {
      const companyFields = fields.filter(field => field.entityId === sectionId && /company|employer|organization/i.test(field.label || ''));
      const matches = employers.filter(entry => companyFields.some(field => field.currentValue && field.currentValue.trim().toLowerCase() === entry.company.trim().toLowerCase()));
      if (matches.length === 1) employmentId = matches[0].id;
    }
    if (employmentId) { run.employmentMappings[mappingKey] = employmentId; sectionMappings[sectionId] = employmentId; }
    else if (fields.some(field => field.entityId === sectionId && !field.currentValue)) run.employmentChoices.push({sectionId,label:fields.find(field => field.entityId===sectionId)?.section || 'Work history', employers:employers.map(({id,company})=>({id,company}))});
  }
  return fields.map(field => field.entityType === 'employment' ? {...field, employmentId:sectionMappings[field.entityId] || '', entityUnresolved:!sectionMappings[field.entityId]} : field);
}

async function mutateRun(tabId, change) {
  let result;
  runWriteChain = runWriteChain.catch(() => {}).then(async () => {
    const runs = await getRuns();
    const current = runs[String(tabId)];
    if (!current || (current.siteRevision != null && siteRevision(tabId) !== current.siteRevision)) { result = null; return; }
    if (change(current) === false || (current.siteRevision != null && siteRevision(tabId) !== current.siteRevision)) { result = null; return; }
    result = {...current, revision:(current.revision || 0)+1,workerId:WORKER_ID,updatedAt:new Date().toISOString()};
    runs[String(tabId)] = result;
    await chrome.storage.session.set({[RUN_STORAGE_KEY]:runs});
  });
  await runWriteChain;
  return result;
}

async function validatePageOnly(tabId, {refreshDestination = false} = {}) {
  const run = await getRun(tabId);
  if (!run || processingTabs.has(tabId) || saveLocks.has(tabId)) return run;
  const priorFrameId = run.frame?.frameId;
  let inspected;
  try {
    inspected = await sendToApplicationFrame(tabId, run, {type:'JOB_APP_INSPECT'});
  } catch (error) {
    if (!refreshDestination || !error.frameDiscovery) throw error;
    const discovery = await discoverApplicationFrame(tabId, () => assertRunSiteAuthority(tabId, run), null, String(tabId) + ':' + run.startedAt);
    if (discovery.errorCode) return saveRun(pauseForFrame(run, discovery));
    updateSelectedFrame(tabId, run, discovery);
    inspected = {ok: true, inspection: discovery.inspection};
  }
  const validated = await sendToApplicationFrame(tabId, run, {type:'JOB_APP_VALIDATE'});
  if (!inspected?.ok || !validated?.ok) throw new Error('The page could not be checked. Try Check again.');
  const inspection = inspected.inspection;
  return mutateRun(tabId, current => {
    if (current.startedAt !== run.startedAt || current.frame?.frameId !== priorFrameId || current.pageSignature !== run.pageSignature) return false;
    if (refreshDestination) {
      current.frame = run.frame;
      current.frameId = run.frameId;
      if (current.selectedDestination && run.frame.destination) {
        current.selectedDestination = {...run.frame.destination, frameId: run.frame.frameId};
      }
    }
    const signature = pageSignature(inspection,current.frame);
    const pageChanged = signature !== current.pageSignature;
    const needsFill = pageChanged || current.waitingFor === 'page_changed';
    if (pageChanged) {
      if (current.lastAction !== 'next') current.pageNumber = (current.pageNumber || 1) + 1;
      current.lastAction = null;
      current.waitingLabel = null;
      current.reviewRequired = [];
      current.jobContext = mergeJobContext(current.jobContext, inspection.page);
      current.pageSignature=signature; current.suggestions={}; current.generatedSuggestions={}; current.semanticSearch={};
      for (const op of Object.values(current.aiOperations || {})) if(op.status==='pending') op.status='interrupted';
    }
    for (const [id,suggestion] of Object.entries(current.suggestions || {})) {
      const field=inspection.fields.find(field=>field.id===id);
      const hasText = String(field?.currentValue || '').trim().length > 0;
      if(!field || hasText || field.handle!==suggestion.field.handle) delete current.suggestions[id];
    }
    for (const [id,suggestion] of Object.entries(current.generatedSuggestions || {})) {
      const field=inspection.fields.find(field=>field.id===id);
      const hasText = String(field?.currentValue || '').trim().length > 0;
      if(!field || hasText || field.handle!==suggestion.field.handle) delete current.generatedSuggestions[id];
    }
    for (const id of Object.keys(current.semanticSearch || {})) {
      const field=inspection.fields.find(item=>item.id===id);
      if(!field || String(field.currentValue||'').trim()) delete current.semanticSearch[id];
    }
    categorizeRun(current,inspection,validated.validation);
    const next=inspection.actions.filter(action=>action.kind==='next');
    const submit=inspection.actions.filter(action=>action.kind==='submit');
    current.nextAction=null;
    if(needsFill) {current.status='waiting_user';current.waitingFor='page_changed';}
    else if(hasBlockingIssues(current,validated.validation)) {current.status='waiting_user';current.waitingFor=current.actionRequired[0]?.reason || 'invalid_field';}
    else if(next.length===1) {current.status='page_ready';current.nextAction=next[0];current.waitingFor=null;}
    else if(submit.length===1) {current.status='ready_for_user_submit';current.waitingFor=null;}
    else {current.status='waiting_user';current.waitingFor='ambiguous_navigation';}
    current.progress=Object.values(current.aiOperations || {}).some(op=>op.status==='pending')?'preparing_suggestions':'ready';
  });
}

async function selectEmployment(message) {
  const run=await getRun(message.tabId);
  const authority = () => assertRunSiteAuthority(message.tabId, run);
  if(!run || processingTabs.has(message.tabId) || saveLocks.has(message.tabId) || run.startedAt!==message.applicationId || run.pageSignature!==message.pageSignature || run.frame?.frameId!==message.frameId) throw new Error('Work-history section changed. Check the page again.');
  const profile=(await getDatasource()).profile;
  if(!profile.employment.some(entry=>entry.id===message.employmentId)) throw new Error('Saved employer is unavailable. Update your profile.');
  const inspected=await sendToFrame(message.tabId,message.frameId,{type:'JOB_APP_INSPECT'}, authority);
  if(pageSignature(inspected.inspection,run.frame)!==run.pageSignature || !inspected.inspection.fields.some(field=>field.entityType==='employment' && field.entityId===message.sectionId)) throw new Error('Work-history section changed. Check the page again.');
  run.employmentMappings ||= {};
  run.employmentMappings[`${run.pageSignature}:${message.sectionId}`]=message.employmentId;
  authority();
  await saveRun(run);
  return {ok:true,run:await checkPage(message.tabId)};
}

async function savedSearchCandidates(field, value) {
  const records=await getRecords();
  const query=String(value || '').trim().slice(0,200);
  return searchEvidence(field, records, {limit: 20, query});
}

async function searchInlineField(message, sender) {
  const {session, field} = await guardInlineField(message, sender, {requireFocus: true});
  if (processingTabs.has(session.tabId) || saveLocks.has(session.tabId)) throw new Error('Application is busy. Search again.');
  const candidates = message.query.trim()
    ? await savedSearchCandidates(field, message.query)
    : savedFieldCandidates(field, await getRecords(), await draftEvidenceRecords());
  const {session: latest, authority} = await guardInlineField(message, sender, {requireFocus: true});
  if (latest.revision !== session.revision) throw new Error('Inline session changed. Search again.');
  const updated = await mutateInlineSession(session.tabId, session.frameId, session.sessionId, current => {
    authority();
    if (processingTabs.has(session.tabId) || saveLocks.has(session.tabId)) throw new Error('Application is busy. Search again.');
    if (current.revision !== session.revision) throw new Error('Inline session changed. Search again.');
    const registered = candidates.map(candidate => ({...candidate, candidateId: `search:${current.revision + 1}:${crypto.randomUUID()}`}));
    return {...current, suggestions: {...current.suggestions, [field.id]: {...current.suggestions[field.id], field, candidates: registered}}};
  });
  return inlineReply(updated, message.requestId, {candidates: updated.suggestions[field.id].candidates});
}

async function semanticSearchInlineField(message, sender, {requireFocus = true} = {}) {
  const {session,field}=await guardInlineField(message,sender,{requireFocus});
  if(processingTabs.has(session.tabId)||saveLocks.has(session.tabId)) throw new Error('Application is busy. Try again.');
  const sessionId = String(session.tabId) + ':' + (session.attachedRun?.applicationId || session.sessionId);
  const traceContext = createPhoenixTrace(sessionId, {'phoenix.action': 'semantic_search', 'application.field_id': field.id});
  await persistPhoenixAction(traceContext, 'semantic_search', sessionId, {'application.field_id': field.id});
  void tracePhoenixEvent('semantic_search', {'application.field_id': field.id}, sessionId, {traceContext, root: true, defer: true, input: {field}});
  const settings=await getSettings(); const apiKey=await getTypeSafeApiKey();
  if(!settings.typesafeEnabled||!apiKey) {
    void tracePhoenixEvent('semantic_search', {'ai.skipped': true, 'ai.reason': !settings.typesafeEnabled ? 'provider_disabled' : 'missing_provider_key'}, sessionId, {traceContext, root: true, output: {retained: false, reason: !settings.typesafeEnabled ? 'provider_disabled' : 'missing_provider_key'}});
    void clearPhoenixAction(traceContext);
    throw new Error('Enable TypeSafe saved-answer search and add its API key in Settings.');
  }
  const records=await getRecords();
  let traceOutcome = {retained: false, reason: 'incomplete'};
  try {
    const [result]=await semanticMatcher.match({fields:[field],records,apiKey,enabled:true,
      scope:`inline:${session.sessionId}:${session.pageSignature}`,retry:Boolean(message.retry),
      sessionId, traceContext});
    const [liveSettings,liveRecords]=await Promise.all([getSettings(),getRecords()]);
    if(!liveSettings.typesafeEnabled||semanticFingerprint(field,liveRecords)!==result.fingerprint) throw new Error('Saved answers changed. Try again.');
    const {session:latest,authority}=await guardInlineField(message,sender,{requireFocus});
    if(latest.revision!==session.revision) throw new Error('Inline session changed. Try again.');
    if(result.status!=='matched') { traceOutcome = {retained: true, status: result.status}; return inlineReply(latest,message.requestId,{semanticStatus:result.status}); }
    const updated=await mutateInlineSession(session.tabId,session.frameId,session.sessionId,current=>{
      authority();
      if(current.revision!==session.revision) throw new Error('Inline session changed. Try again.');
      const registered={...result.candidate,candidateId:`semantic:${current.revision+1}:${crypto.randomUUID()}`};
      const prior=current.suggestions[field.id]?.candidates||[];
      const candidates=prior.some(candidate=>candidate.answer===registered.answer)?prior:[registered,...prior];
      return {...current,suggestions:{...current.suggestions,[field.id]:{...current.suggestions[field.id],field,candidates}}};
    });
    traceOutcome = {retained: true, status: 'matched'};
    return inlineReply(updated,message.requestId,{semanticStatus:'matched',semanticCandidate:updated.suggestions[field.id].candidates[0]});
  } catch (error) {
    traceOutcome = {retained: false, reason: error.message};
    throw error;
  } finally {
    void tracePhoenixEvent('semantic_search', {'application.field_id': field.id, 'ai.retained': Boolean(traceOutcome.retained)}, sessionId, {traceContext, root: true, statusCode: traceOutcome.retained ? 'OK' : 'ERROR', statusMessage: traceOutcome.reason || '', output: traceOutcome});
    void clearPhoenixAction(traceContext);
  }
}

async function searchSavedAnswers(message) {
  const {run,field}=await guardedDraftField(message);
  const candidates=await savedSearchCandidates(field,message.query);
  const updated=await mutateRun(message.tabId,current=>{
    if(current.startedAt!==run.startedAt || current.pageSignature!==run.pageSignature) return false;
    current.suggestions ||= {};
    current.suggestions[field.id]={tabId:message.tabId,frameId:message.frameId,applicationId:run.startedAt,pageSignature:run.pageSignature,field,candidates};
    for(const item of [...(current.actionRequired||[]),...(current.optionalUnresolved||[])]) if(item.fieldId===field.id) item.suggestion=current.suggestions[field.id];
  });
  if(!updated) throw new Error('The application changed. Search again.');
  return {ok:true,candidates,run:updated};
}

async function semanticSearchSavedAnswers(message) {
  const {run,field}=await guardedDraftField(message);
  const sessionId = String(message.tabId) + ':' + run.startedAt;
  const traceContext = createPhoenixTrace(sessionId, {'phoenix.action': 'semantic_search', 'application.field_id': field.id});
  await persistPhoenixAction(traceContext, 'semantic_search', sessionId, {'application.field_id': field.id});
  void tracePhoenixEvent('semantic_search', {'application.field_id': field.id}, sessionId, {traceContext, root: true, defer: true, input: {field}});
  const settings=await getSettings(); const apiKey=await getTypeSafeApiKey();
  if(!settings.typesafeEnabled||!apiKey) {
    void tracePhoenixEvent('semantic_search', {'ai.skipped': true, 'ai.reason': !settings.typesafeEnabled ? 'provider_disabled' : 'missing_provider_key'}, sessionId, {traceContext, root: true, output: {retained: false, reason: !settings.typesafeEnabled ? 'provider_disabled' : 'missing_provider_key'}});
    void clearPhoenixAction(traceContext);
    throw new Error('Enable TypeSafe saved-answer search and add its API key in Settings.');
  }
  const records=await getRecords();
  let traceOutcome = {retained: false, reason: 'incomplete'};
  try {
    const [result]=await semanticMatcher.match({fields:[field],records,apiKey,enabled:true,
      scope:`${run.startedAt}:${run.pageSignature}`,retry:Boolean(message.retry),sessionId, traceContext});
    const [liveSettings,liveRecords]=await Promise.all([getSettings(),getRecords()]);
    if(!liveSettings.typesafeEnabled||semanticFingerprint(field,liveRecords)!==result.fingerprint) throw new Error('Saved answers changed. Try again.');
    await guardedDraftField(message);
    const updated=await mutateRun(message.tabId,current=>{
      if(current.startedAt!==run.startedAt||current.pageSignature!==run.pageSignature)return false;
      current.semanticSearch ||= {}; current.semanticSearch[field.id]={status:result.status};
      if(result.status==='matched') {
        const prior=current.suggestions?.[field.id]?.candidates||[];
        current.suggestions ||= {};
        current.suggestions[field.id]={tabId:message.tabId,frameId:message.frameId,applicationId:run.startedAt,
          pageSignature:run.pageSignature,field,candidates:prior.some(candidate=>candidate.answer===result.candidate.answer)
            ? prior : [result.candidate,...prior]};
      }
      for(const item of [...(current.actionRequired||[]),...(current.optionalUnresolved||[])]) if(item.fieldId===field.id) {
        item.semanticStatus=result.status;
        if(result.status==='matched') {item.suggestion=current.suggestions[field.id];item.reason='Saved answer found — review it before use';}
        else if(result.status==='none') item.reason='No clear saved-answer match';
        else if(result.status==='failed') item.reason='Couldn’t search saved answers — try again';
      }
    });
    if(!updated) throw new Error('The application changed. Try again.');
    traceOutcome = {retained: true, status: result.status};
    return {ok:true,semanticStatus:result.status,candidates:result.status==='matched'?[result.candidate]:[],run:updated};
  } catch (error) {
    traceOutcome = {retained: false, reason: error.message};
    throw error;
  } finally {
    void tracePhoenixEvent('semantic_search', {'application.field_id': field.id, 'ai.retained': Boolean(traceOutcome.retained)}, sessionId, {traceContext, root: true, statusCode: traceOutcome.retained ? 'OK' : 'ERROR', statusMessage: traceOutcome.reason || '', output: traceOutcome});
    void clearPhoenixAction(traceContext);
  }
}

function aiFieldSnapshot(field = {}) {
  return {
    id: field.id,
    handle: field.handle,
    label: field.label,
    fieldType: field.type,
    currentValue: field.currentValue,
    rawValue: field.rawValue,
    editRevision: field.editRevision,
    fieldOptions: field.options || [],
    fieldWidget: field.widget || '',
    fieldConstraints: field.constraints || {},
    fieldMultiple: Boolean(field.multiple),
    helpText: String(field.helpText || ''),
    nearbyContext: String(field.nearbyContext || ''),
    section: String(field.section || ''),
    labelConfidence: String(field.labelConfidence || ''),
    entityId: String(field.entityId || ''),
    entityType: String(field.entityType || ''),
  };
}

function aiEvidenceRevision(run, inspection, datasource) {
  return JSON.stringify({
    context: run.jobContext || {},
    employmentMappings: run.employmentMappings || {},
    profile: datasource?.profile || {},
    records: datasource?.answerRecords || [],
    coverMessages: datasource?.coverMessages || [],
    applicationAnswers: run.answers || [],
    pageFacts: (inspection?.fields || []).map((field) => aiFieldSnapshot(field)),
  });
}

function aiFingerprint(run, fields, settings, evidenceRevision) {
  return JSON.stringify({applicationId:run.startedAt,frame:run.frame?.frameId,page:run.pageSignature,fields:fields.map(({id,handle,entityId,employmentId})=>({id,handle,entityId,employmentId})),evidenceRevision,provider:settings.aiProvider,model:settings.aiModel,typesafeEnabled:settings.typesafeEnabled,typesafeAutofillEnabled:settings.typesafeAutofillEnabled,typesafeAutofillSensitive:settings.typesafeAutofillSensitive,typesafeNoMatchTop:settings.typesafeNoMatchTop,promptVersion:'jev-top-answer-1'});
}

function suggestionRequestSnapshot(run, field, inspection, datasource, settings, jobContext) {
  const contextualRun = { ...run, jobContext };
  return {
    startedAt: run.startedAt,
    waitingFor: run.waitingFor,
    pageSignature: run.pageSignature,
    frameId: run.frame?.frameId,
    field: aiFieldSnapshot(field),
    settings: { aiProvider: settings.aiProvider, aiModel: settings.aiModel },
    sourceJobContext: run.jobContext || {},
    jobContext,
    evidenceRevision: aiEvidenceRevision(contextualRun, inspection, datasource),
  };
}

function sameSuggestionRun(run, snapshot) {
  return Boolean(run
    && run.startedAt === snapshot.startedAt
    && run.waitingFor === snapshot.waitingFor
    && run.pageSignature === snapshot.pageSignature
    && run.frame?.frameId === snapshot.frameId
    && SAVABLE_RUN_STATUSES.has(run.status)
    && JSON.stringify(run.jobContext || {}) === JSON.stringify(snapshot.sourceJobContext || {}));
}

function hasUsableSuggestion(suggestion, field) {
  return Boolean(suggestion?.candidates?.some(candidate => candidate.kind !== 'related'
    && String(candidate?.answer || '').trim() && validateFillValue(field, candidate.answer).ok));
}

async function currentSuggestionDestination(tabId, snapshot) {
  const run = await getRun(tabId);
  if (!sameSuggestionRun(run, snapshot)) return null;
  const authority = siteAuthority(tabId);
  const settings = await getSettings();
  if (settings.aiProvider !== snapshot.settings.aiProvider || settings.aiModel !== snapshot.settings.aiModel) return null;
  const [datasource, inspected] = await Promise.all([
    getDatasource(),
    sendToFrame(tabId, snapshot.frameId, { type: 'JOB_APP_INSPECT' }, authority),
  ]);
  if (!inspected?.ok || pageSignature(inspected.inspection, run.frame) !== snapshot.pageSignature) return null;
  const field = inspected.inspection.fields.find((item) => item.id === snapshot.field.id);
  if (!field || String(field.currentValue || '') !== String(snapshot.field.currentValue || '')
    || !sameFieldSnapshot(field, snapshot.field)) return null;
  const contextualRun = { ...run, jobContext: snapshot.jobContext };
  if (aiEvidenceRevision(contextualRun, inspected.inspection, datasource) !== snapshot.evidenceRevision) return null;
  return { run, inspection: inspected.inspection };
}

async function scheduleAi(tabId,{retry=false}={}) {
  if(backgroundJobs.has(tabId) || processingTabs.has(tabId) || saveLocks.has(tabId)) return;
  const run=await getRun(tabId);
  if(!run || !SAVABLE_RUN_STATUSES.has(run.status) || !Number.isInteger(run.frame?.frameId)) return;
  const sessionId = String(tabId) + ':' + run.startedAt;
  const traceContext = createPhoenixTrace(sessionId, {'phoenix.action': 'fill_page', 'application.page': run.pageSignature, 'application.frame_id': run.frame.frameId});
  await persistPhoenixAction(traceContext, 'fill_page', sessionId, {'application.page': run.pageSignature, 'application.frame_id': run.frame.frameId});
  const traceSkip = reason => {
    void tracePhoenixEvent('fill_page_result', {'ai.skipped': true, 'ai.reason': reason}, sessionId, {traceContext, output: {retained: false, reason}});
    void tracePhoenixEvent('fill_page', {'ai.skipped': true, 'ai.reason': reason}, sessionId, {traceContext, root: true, output: {retained: false, reason}});
    void clearPhoenixAction(traceContext);
  };
  void tracePhoenixEvent('fill_page', {'ai.retry': Boolean(retry)}, sessionId, {traceContext, root: true, defer: true, input: {pageSignature: run.pageSignature, frameId: run.frame.frameId}});
  const settings=await getSettings();
  const [apiKey,typesafeApiKey]=await Promise.all([getApiKey(settings.aiProvider),getTypeSafeApiKey()]);
  const inspected=await sendToApplicationFrame(tabId,run,{type:'JOB_APP_INSPECT'});
  if(!inspected?.ok || pageSignature(inspected.inspection,run.frame)!==run.pageSignature) { traceSkip('page_changed_before_ai'); return; }
  const validated=await sendToApplicationFrame(tabId,run,{type:'JOB_APP_VALIDATE'});
  const invalidIds=new Set((validated?.validation?.invalid || []).map(field=>field.fieldId));
  const datasource=await getDatasource();
  const fields=resolveEmploymentFields(run,inspected.inspection.fields,datasource.profile);
  const jevReady = settings.typesafeEnabled && Boolean(typesafeApiKey);
  const conflicting = new Set(jevReady ? fields.filter(field => hasConflictingSemanticEvidence(field, datasource.answerRecords, settings.typesafeAutofillSensitive)).map(field => field.id) : []);
  const eligibility = fields.map(field => ({
    fieldId: field.id, label: field.label, required: Boolean(field.required),
    reason: String(field.currentValue || '').trim() ? 'existing_value'
      : !readableQuestion(field) ? 'unreadable_question'
      : inferSensitivity(field.label,field.id)==='legal' && !(jevReady && settings.typesafeAutofillSensitive) ? 'legal_manual'
      : field.entityUnresolved ? 'unresolved_employment'
      : hasUsableSuggestion(run.suggestions?.[field.id], field) && !(jevReady && settings.typesafeAutofillEnabled
        && datasource.answerRecords.some(record => semanticEligible(field, record, { allowSensitive: settings.typesafeAutofillSensitive })))
        && !conflicting.has(field.id) && !invalidIds.has(field.id) ? 'saved_answer_ready' : 'eligible',
    candidates: (run.suggestions?.[field.id]?.candidates || []).map(candidate => ({
      sourceKey: candidate.sourceKey, kind: candidate.kind, valueValid: validateFillValue(field, candidate.answer).ok,
    })),
  }));
  void tracePhoenixEvent('fill_page_eligibility', {}, sessionId, {traceContext, output: {recordCount: datasource.answerRecords.length, fields: eligibility}});
  const eligibleIds = new Set(eligibility.filter(field => field.reason === 'eligible').map(field => field.fieldId));
  const candidateFields=fields.filter(field=>eligibleIds.has(field.id))
    .sort((left,right)=>Number(Boolean(right.required))-Number(Boolean(left.required)));
  const unresolved=candidateFields.filter(field=>field.required);
  if(!candidateFields.length) { traceSkip('no_eligible_fields'); return; }
  if(!apiKey && !jevReady) {
    await mutateRun(tabId,current=>{
      if(current.startedAt!==run.startedAt || current.pageSignature!==run.pageSignature) return false;
      current.llmError=missingProviderKeyMessage(settings.aiProvider);
    });
    traceSkip('missing_provider_key');
    return;
  }
  const planner=run.aiOperations?.planner;
  const retryableStates=new Set(['failed','interrupted']);
  const semanticRetry=retry && unresolved.some(field=>run.semanticSearch?.[field.id]?.status==='failed');
  const plannerFields=(retry
    ? (retryableStates.has(planner?.status) || semanticRetry ? candidateFields : [])
    : candidateFields).filter(field => writingField(field) || structuredField(field) || field.type === 'number'
      || ((settings.typesafeEnabled && typesafeApiKey) && !writingField(field)));
  const suggestionFields=retry
    ? candidateFields.filter(writingField).filter(field=>retryableStates.has(run.aiOperations?.[`suggestion:${field.id}`]?.status) && !run.generatedSuggestions?.[field.id])
    : candidateFields.filter(writingField).filter(field=>!run.generatedSuggestions?.[field.id]);
  // Related local evidence needs drafting, but does not need rediscovery.
  const semanticFields=candidateFields.filter(field=>conflicting.has(field.id)
    || jevReady && settings.typesafeAutofillEnabled && datasource.answerRecords.some(record=>semanticEligible(field,record,{allowSensitive:settings.typesafeAutofillSensitive}))
    || !run.suggestions?.[field.id]?.candidates?.some(candidate=>
    String(candidate.answer || '').trim() && validateFillValue(field, candidate.answer).ok));
  if(!apiKey && !semanticFields.length) { traceSkip('missing_provider_key'); return; }
  if(!plannerFields.length && !semanticFields.length && !suggestionFields.length) { traceSkip('cached_or_no_pending_ai'); return; }
  const operationFields=[...new Map([...plannerFields,...semanticFields,...suggestionFields].map(field=>[field.id,field])).values()];
  const evidenceRevision=aiEvidenceRevision(run,inspected.inspection,datasource);
  const fingerprint=aiFingerprint(run,operationFields,settings,evidenceRevision);
  const op=planner;
  if(op?.cacheKey===fingerprint && ((!retry && ['completed','failed','interrupted'].includes(op.status)) || op.status==='pending')) { traceSkip('operation_already_recorded'); return; }
  const id=`${WORKER_ID}:${Date.now()}:${Math.random()}`;
  const operationKey=plannerFields.length ? 'planner' : 'suggestion_batch';
  const snapshot={startedAt:run.startedAt,pageSignature:run.pageSignature,frameId:run.frame.frameId,cacheKey:fingerprint,id,operationKey,evidenceRevision,jobContext:run.jobContext || {},settings};
  await mutateRun(tabId,current=>{
    if(current.startedAt!==snapshot.startedAt || current.pageSignature!==snapshot.pageSignature) return false;
    current.aiOperations ||= {};
    current.aiOperations[operationKey]={status:'pending',cacheKey:fingerprint,id,workerId:WORKER_ID};
    current.semanticSearch ||= {};
    if(settings.typesafeEnabled && typesafeApiKey) for(const field of semanticFields) current.semanticSearch[field.id]={status:'searching'};
    current.progress='preparing_suggestions'; current.llmError=null;
  });
  const ownedSuggestionFields=suggestionFields.filter(field=>claimDraftField(draftFieldKey(tabId,snapshot.frameId,field),id));
  let aiError = null;
  const job=prepareAi(tabId,snapshot,plannerFields,semanticFields,ownedSuggestionFields,fields,datasource,apiKey,typesafeApiKey,{retry, traceContext}).catch(async error=>{
    aiError = error;
    await mutateRun(tabId,current=>{
      if(current.aiOperations?.[operationKey]?.id!==id) return false;
      current.aiOperations[operationKey].status='failed';current.aiOperations[operationKey].error=error.message;current.llmError=error.message;current.progress='ready';
    });
  }).finally(()=>{
    void tracePhoenixEvent('fill_page', {'ai.retry': Boolean(retry), 'ai.retained': !aiError}, sessionId, {traceContext, root: true, statusCode: aiError ? 'ERROR' : 'OK', statusMessage: aiError?.message || '', output: {retained: !aiError, reason: aiError?.message || ''}});
    void clearPhoenixAction(traceContext);
    for(const field of ownedSuggestionFields) releaseDraftField(draftFieldKey(tabId,snapshot.frameId,field),id);
    if(backgroundJobs.get(tabId)===job) backgroundJobs.delete(tabId);
  });
  backgroundJobs.set(tabId,job);
}

async function currentAiDestination(tabId,snapshot,field=null) {
  const run=await getRun(tabId);
  if(!run || run.startedAt!==snapshot.startedAt || run.pageSignature!==snapshot.pageSignature || run.frame?.frameId!==snapshot.frameId || run.aiOperations?.[snapshot.operationKey]?.id!==snapshot.id || !SAVABLE_RUN_STATUSES.has(run.status)) return null;
  const authority = siteAuthority(tabId);
  const settings=await getSettings();
  if(settings.aiProvider!==snapshot.settings.aiProvider || settings.aiModel!==snapshot.settings.aiModel
    || settings.typesafeEnabled!==snapshot.settings.typesafeEnabled
    || settings.typesafeAutofillEnabled!==snapshot.settings.typesafeAutofillEnabled
    || settings.typesafeAutofillSensitive!==snapshot.settings.typesafeAutofillSensitive
    || settings.typesafeNoMatchTop!==snapshot.settings.typesafeNoMatchTop) return null;
  const [datasource, inspected]=await Promise.all([getDatasource(),sendToFrame(tabId,snapshot.frameId,{type:'JOB_APP_INSPECT'}, authority)]);
  if(!inspected?.ok || pageSignature(inspected.inspection,run.frame)!==snapshot.pageSignature) return null;
  if(aiEvidenceRevision(run,inspected.inspection,datasource)!==snapshot.evidenceRevision) return null;
  if(field) {
    const live=inspected.inspection.fields.find(item=>item.id===field.id);
    if(!live || live.currentValue!==field.currentValue || !sameFieldSnapshot(live,aiFieldSnapshot(field))) return null;
  }
  return {run,inspection:inspected.inspection};
}

async function applySemanticAutofills(tabId, snapshot, destination, results, fields, datasource, traceContext) {
  if (!snapshot.settings.typesafeAutofillEnabled) return {applied:new Set(), destination};
  const records = new Map(datasource.answerRecords.map(record=>[record.key,record]));
  const decisions = results.flatMap(result=>{
    const field=fields.find(item=>item.id===result.fieldId);
    const candidate=result.candidate;
    if(result.status!=='matched'||result.coverage?.complete!==true||!field||field.multiple||!candidate)return [];
    const keys=sourceKeysForCandidate(candidate);
    const sources=keys.map(key=>records.get(key));
    const revisions=candidate.kind==='semantic'
      ? sources.length===1 && semanticRecordRevision(sources[0])===candidate.sourceRevision
      : sources.every(source=>source&&candidate.sourceRevisions?.[source.key]===semanticRecordRevision(source));
    if(!keys.length||sources.some(source=>!source)||!revisions||!validateFillValue(field,candidate.answer).ok
      ||sources.some(source=>source.reusePolicy==='review_only'||source.semantic?.reusePolicy==='review_only'))return [];
    if(!snapshot.settings.typesafeAutofillSensitive && (inferSensitivity(field.label,field.id)!=='safe'
      || sources.some(source=>source.sensitivity!=='safe'||inferSensitivity(source.question,source.key)!=='safe')))return [];
    return [{fieldId:field.id,handle:field.handle,action:'fill',value:candidate.answer,evidenceKeys:keys,
      sensitivity:inferSensitivity(field.label,field.id),confidence:'high',confirmationState:'confirmed',matchKind:'semantic',compatible:true,jevAutofill:true,
      semantic:candidate.semantic,expectedRawValue:field.rawValue,expectedEditRevision:field.editRevision,
      reason:'JEV-selected saved answer'}];
  });
  if(!decisions.length)return {applied:new Set(),destination};
  const result=await sendToFrame(tabId,snapshot.frameId,{type:'JOB_APP_APPLY',applicationId:snapshot.startedAt,
    decisions,deadline:Date.now()+5000},siteAuthority(tabId));
  if(!result?.ok)throw new Error(result?.error||'Could not apply low-risk JEV matches');
  const inspected=await sendToFrame(tabId,snapshot.frameId,{type:'JOB_APP_INSPECT'},siteAuthority(tabId));
  if(!inspected?.ok||pageSignature(inspected.inspection,destination.run.frame)!==snapshot.pageSignature)return {applied:new Set(),destination:null};
  const expectedById=new Map(decisions.map(decision=>[decision.fieldId,String(decision.value).trim()]));
  const applied=new Set(inspected.inspection.fields.filter(field=>expectedById.get(field.id)===String(field.currentValue||'').trim()).map(field=>field.id));
  const unrelatedChanged=destination.inspection.fields.some(before=>{
    const after=inspected.inspection.fields.find(field=>field.id===before.id);
    return !expectedById.has(before.id)&&(!after||after.currentValue!==before.currentValue||!sameFieldSnapshot(after,aiFieldSnapshot(before)));
  });
  if(unrelatedChanged)return {applied,destination:null};
  const capture=await sendToFrame(tabId,snapshot.frameId,{type:'JOB_APP_CAPTURE'},siteAuthority(tabId));
  if(capture?.records)await persistLearnedRecords(capture.records,destination.run,{promote:false,assertAuthority:()=>assertRunSiteAuthority(tabId,destination.run)});
  await mutateRun(tabId,current=>{
    if(current.aiOperations?.[snapshot.operationKey]?.id!==snapshot.id||current.pageSignature!==snapshot.pageSignature)return false;
    const byId=new Map((current.semanticAutofills||[]).map(item=>[item.fieldId,item]));
    for(const decision of decisions)if(applied.has(decision.fieldId)){
      const field=fields.find(item=>item.id===decision.fieldId);
      byId.set(decision.fieldId,{fieldId:decision.fieldId,label:field?.label||decision.fieldId,value:decision.value,
        reason:'Automatically filled from JEV top saved answer'});
    }
    current.semanticAutofills=[...byId.values()];
  });
  snapshot.evidenceRevision=aiEvidenceRevision(destination.run,inspected.inspection,datasource);
  void tracePhoenixEvent('jev_autofill_result',{'llm.provider':'typesafe','typesafe.autofilled':applied.size,
    'typesafe.rejected':decisions.length-applied.size},String(tabId)+':'+snapshot.startedAt,{traceContext,output:{fieldIds:[...applied]}});
  return {applied,destination:{run:destination.run,inspection:inspected.inspection}};
}

async function prepareAi(tabId,snapshot,plannerFields,semanticFields,suggestionFields,allFields,datasource,apiKey,typesafeApiKey,{retry=false, traceContext: parentTraceContext = null}={}) {
  const {aiProvider:provider,aiModel:model}=snapshot.settings;
  const sessionId = String(tabId) + ':' + snapshot.startedAt;
  const traceContext = parentTraceContext || createPhoenixTrace(sessionId, {'phoenix.action': 'fill_page', 'application.page': snapshot.pageSignature, 'application.frame_id': snapshot.frameId, 'typesafe.field_ids': JSON.stringify(semanticFields.map(field => field.id)), 'typesafe.source_keys': JSON.stringify(datasource.answerRecords.map(record => record.key))});
  traceContext.attributes = {...traceContext.attributes, 'typesafe.field_ids': JSON.stringify(semanticFields.map(field => field.id)), 'typesafe.source_keys': JSON.stringify(datasource.answerRecords.map(record => record.key))};
  if (!parentTraceContext) void tracePhoenixEvent('fill_page', {'ai.planner_fields': plannerFields.length, 'ai.semantic_fields': semanticFields.length, 'ai.suggestion_fields': suggestionFields.length, 'ai.retry': Boolean(retry)}, sessionId, {traceContext, root: true, input: {plannerFields, semanticFields, suggestionFields}});
  const pageRecords=allFields.filter(field=>field.currentValue && readableQuestion(field)).map(field=>({key:`page:${field.id}`,question:field.label,answer:field.currentValue,provenance:'current application page',sensitivity:inferSensitivity(field.label,field.id),entityId:field.entityId,entityType:field.entityType}));
  const evidence=[...datasource.answerRecords,...profileEvidenceRecords(datasource.profile),...pageRecords];
  const companySpecific=field=>/\b(why.*(?:join|company|work|role)|motivat|cover letter|what interests you)\b/i.test(`${field.label||''} ${field.helpText||''}`);
  let activeDrafts=0;
  const draftWaiters=[];
  const withDraftSlot=async task=>{
    if(activeDrafts>=2)await new Promise(resolve=>draftWaiters.push(resolve));
    activeDrafts+=1;
    try{return await task();}
    finally{activeDrafts-=1;draftWaiters.shift()?.();}
  };
  const generateDrafts=async tasks=>{
    let index=0;
    const consume=async()=>{while(index<tasks.length){
      const field=tasks[index++]; const key=`suggestion:${field.id}`;
      await withDraftSlot(async()=>{
      if(!(await currentAiDestination(tabId,snapshot,field))) {releaseDraftField(draftFieldKey(tabId,snapshot.frameId,field),snapshot.id);return;}
      await mutateRun(tabId,current=>{if(current.aiOperations?.[snapshot.operationKey]?.id!==snapshot.id)return false;current.aiOperations[key]={status:'pending',workerId:WORKER_ID,id:snapshot.id,cacheKey:snapshot.cacheKey};});
      try {
        let ranked=rankSuggestionEvidence(field,evidence,{limit:40});
        const eligibleNarrative=narrativeEvidence(field,evidence);
        if(snapshot.settings.typesafeEnabled&&typesafeApiKey&&eligibleNarrative.length>20){
          try{
            const shortlist=rankSuggestionEvidence(field,eligibleNarrative,{limit:eligibleNarrative.length});
            ranked=await semanticMatcher.rankNarrative({field,records:shortlist,apiKey:typesafeApiKey,enabled:true,scope:`${snapshot.startedAt}:${snapshot.pageSignature}`,sessionId,traceContext});
          }
          catch(error){void tracePhoenixEvent('jev_narrative_ranking',{'llm.provider':'typesafe','ai.validation_error':error.message},sessionId,{traceContext,statusCode:'ERROR',statusMessage:error.message});}
        }
        const generated=await callAnswerSuggestions({apiKey,field,page:snapshot.jobContext,records:[...savedClosingEvidence(field,datasource),...ranked]},{provider,model,sessionId,traceContext});
        if(!(await currentAiDestination(tabId,snapshot,field))) {
          void tracePhoenixEvent('answer_suggestions_result', {'application.field_id': field.id, 'ai.suggestion_count': generated.suggestions?.length || 0, 'ai.retained': false, 'ai.discard_reason': 'page_changed'}, sessionId, {traceContext, output: {...generated, retained: false, discardReason: 'page_changed'}});
          await mutateRun(tabId,current=>{if(current.aiOperations?.[key]?.id!==snapshot.id)return false;current.aiOperations[key].status='interrupted';}); return;
        }
        const committed=await mutateRun(tabId,current=>{
          if(current.aiOperations?.[snapshot.operationKey]?.id!==snapshot.id||current.pageSignature!==snapshot.pageSignature)return false;
          current.generatedSuggestions||={};
          if(!hasUsableSuggestion(current.suggestions?.[field.id], field))current.generatedSuggestions[field.id]={tabId,frameId:snapshot.frameId,applicationId:snapshot.startedAt,pageSignature:snapshot.pageSignature,field,...generated,snapshot:{...snapshot,field:aiFieldSnapshot(field)}};
          current.aiOperations[key].status='completed';
        });
        if(committed)void tracePhoenixEvent('answer_suggestions_result',{'application.field_id':field.id,'ai.suggestion_count':generated.suggestions?.length||0,'ai.retained':true},sessionId,{traceContext,output:{...generated,retained:true}});
      }catch(error){void tracePhoenixEvent('answer_suggestions_result',{'application.field_id':field.id,'ai.validation_error':error.message},sessionId,{traceContext,statusCode:'ERROR',statusMessage:error.message,output:{retained:false}});await mutateRun(tabId,current=>{if(current.aiOperations?.[key]?.id!==snapshot.id)return false;current.aiOperations[key].status='failed';current.aiOperations[key].error=error.message;current.llmError=error.message;});}
      finally{releaseDraftField(draftFieldKey(tabId,snapshot.frameId,field),snapshot.id);}
      });
    }};
    await Promise.all([consume(),consume()]);
  };
  const immediateDraftFields=apiKey?suggestionFields.filter(companySpecific):[];
  const immediateDraftPromise=generateDrafts(immediateDraftFields);
  let semanticFailure=false;
  if(snapshot.settings.typesafeEnabled && typesafeApiKey && semanticFields.length) {
    const semanticResults=await semanticMatcher.match({fields:semanticFields,records:datasource.answerRecords,
      apiKey:typesafeApiKey,enabled:true,scope:`${snapshot.startedAt}:${snapshot.pageSignature}`,retry,
      alwaysTop:true,noMatchTop:snapshot.settings.typesafeNoMatchTop,
      allowSensitive:snapshot.settings.typesafeAutofillSensitive,
      sessionId, traceContext});
    let destination=await currentAiDestination(tabId,snapshot);
    if(destination) {
      const fieldsById=new Map(destination.inspection.fields.map(field=>[field.id,field]));
      const validResults=semanticResults.filter(result=>{
        const original=semanticFields.find(field=>field.id===result.fieldId);
        const live=fieldsById.get(result.fieldId);
        return original && live && !String(live.currentValue||'').trim() && sameFieldSnapshot(live,aiFieldSnapshot(original));
      });
      const discardedResults = semanticResults.filter(result => !validResults.includes(result));
      if (discardedResults.length) void tracePhoenixEvent('saved_answer_match_result', {
        'llm.provider': 'typesafe', 'typesafe.discarded': discardedResults.length, 'ai.retained': false, 'ai.discard_reason': 'page_changed',
      }, sessionId, {traceContext, statusCode: 'ERROR', statusMessage: 'page_changed', output: {retained: false, reason: 'page_changed', results: discardedResults}});
      const autofill=await applySemanticAutofills(tabId,snapshot,destination,validResults,semanticFields,datasource,traceContext);
      destination=autofill.destination;
      if(!destination){await immediateDraftPromise;await validatePageOnly(tabId);return;}
      await mutateRun(tabId,current=>{
        if(current.aiOperations?.[snapshot.operationKey]?.id!==snapshot.id || current.pageSignature!==snapshot.pageSignature)return false;
        current.semanticSearch ||= {}; current.suggestions ||= {};
        for(const result of validResults) {
          const autofilled=autofill.applied.has(result.fieldId);
          current.semanticSearch[result.fieldId]={status:autofilled?'autofilled':result.status,route:result.route,disposition:result.disposition,coverage:result.coverage};
          if(autofilled){delete current.suggestions[result.fieldId];delete current.generatedSuggestions?.[result.fieldId];}
          else if(result.status==='matched') {
            const field=semanticFields.find(item=>item.id===result.fieldId);
            current.suggestions[result.fieldId]={tabId,frameId:snapshot.frameId,applicationId:snapshot.startedAt,
              pageSignature:snapshot.pageSignature,field,candidates:[result.candidate]};
          }
        }
      });
      const outcomes=new Map(validResults.map(result=>[result.fieldId,autofill.applied.has(result.fieldId)?'autofilled':result.status]));
      semanticFailure=[...outcomes.values()].includes('failed');
      const continueWithGeneration=field=>!['matched','autofilled'].includes(outcomes.get(field.id));
      for(const field of suggestionFields.filter(field=>!continueWithGeneration(field))) {
        releaseDraftField(draftFieldKey(tabId,snapshot.frameId,field),snapshot.id);
      }
      plannerFields=plannerFields.filter(field=>continueWithGeneration(field)
        && !(snapshot.settings.typesafeEnabled&&typesafeApiKey&&writingField(field)));
      suggestionFields=suggestionFields.filter(continueWithGeneration);
      await validatePageOnly(tabId);
    } else if (semanticResults.length) {
      void tracePhoenixEvent('saved_answer_match_result', {
        'llm.provider': 'typesafe', 'typesafe.discarded': semanticResults.length, 'ai.retained': false, 'ai.discard_reason': 'page_changed',
      }, sessionId, {traceContext, statusCode: 'ERROR', statusMessage: 'page_changed', output: {retained: false, reason: 'page_changed', results: semanticResults}});
    }
  }
  if(!apiKey) {
    await mutateRun(tabId,current=>{
      if(current.aiOperations?.[snapshot.operationKey]?.id!==snapshot.id)return false;
      current.aiOperations[snapshot.operationKey].status=semanticFailure?'failed':'completed';
      if(semanticFailure){current.aiOperations[snapshot.operationKey].error='Couldn’t search saved answers — try again';current.llmError='Couldn’t search saved answers — try again';}
      current.progress='ready';
    });
    await validatePageOnly(tabId);
    void tracePhoenixEvent('fill_page_result', {'ai.skipped': true, 'ai.semantic_failure': semanticFailure, 'ai.reason': 'missing_provider_key'}, sessionId, {traceContext, output: {semanticFailure}});
    return;
  }
  plannerFields=plannerFields.filter(field=>!(snapshot.settings.typesafeEnabled&&typesafeApiKey&&writingField(field))
    && selectPlannerEvidence([field],datasource.answerRecords,{limit:1}).length);
  const plannerRecords=selectPlannerEvidence(plannerFields,datasource.answerRecords,{limit:20});
  let decisions=[]; let plannerRejected=[]; let plannerError='';
  if(plannerFields.length) {
    try {
      const planned=await callAnswerPlanner({apiKey,fields:plannerFields,records:plannerRecords,page:snapshot.jobContext},{provider,model,allowPartial:true,sessionId,traceContext});
      decisions=planned.decisions;
      plannerRejected=planned.rejectedDecisions || [];
    }
    catch(error) {plannerError=error.message; void tracePhoenixEvent('answer_planner_result', {'ai.validation_error': error.message}, sessionId, {traceContext, statusCode: 'ERROR', statusMessage: error.message, output: {retained: false}});}
  }
  const proposed=new Set();
  const retainedDecisions=[];
  const discardedDecisions=[];
  for(const decision of decisions) {
    const field=plannerFields.find(item=>item.id===decision.fieldId);
    if(!field) { discardedDecisions.push({decision, reason:'unknown_field'}); continue; }
    if(decision.action!=='fill') { discardedDecisions.push({decision, reason:'action_not_fill'}); continue; }
    if(!(await currentAiDestination(tabId,snapshot,field))) { discardedDecisions.push({decision, reason:'page_changed'}); continue; }
    const keys=[...new Set(decision.evidenceKeys)]; const sources=keys.map(key=>plannerRecords.find(record=>record.key===key));
    if(sources.some(source=>!source)) { discardedDecisions.push({decision, reason:'missing_evidence'}); continue; }
    const candidate={sourceKey:keys[0],sourceKeys:keys,sourceAnswers:Object.fromEntries(sources.map(source=>[source.key,source.answer])),sourceQuestion:sources.map(source=>source.question).join(' + '),answer:decision.value,excerpt:String(decision.value).slice(0,400),provenance:'AI planner',kind:'planner',requiresApproval:true,reason:decision.reason,transformation:decision.transformation || null,confidence:decision.confidence,sensitivity:decision.sensitivity};
    const retained = await mutateRun(tabId,current=>{
      if(current.aiOperations?.[snapshot.operationKey]?.id!==snapshot.id || current.pageSignature!==snapshot.pageSignature) return false;
      current.suggestions ||= {};
      current.suggestions[field.id]={tabId,frameId:snapshot.frameId,applicationId:snapshot.startedAt,pageSignature:snapshot.pageSignature,field,candidates:[candidate]};
    });
    if (!retained) { discardedDecisions.push({decision, reason:'run_changed'}); continue; }
    proposed.add(field.id);
    retainedDecisions.push(decision);
  }
  if (plannerFields.length) void tracePhoenixEvent('answer_planner_result', {
    'ai.decision_count': decisions.length + plannerRejected.length, 'ai.retained_decision_count': retainedDecisions.length,
    'ai.rejected_decision_count': plannerRejected.length, 'ai.discarded_decision_count': discardedDecisions.length,
  }, sessionId, {traceContext, output: {retained: plannerRejected.length === 0 && discardedDecisions.length === 0,
    decisions: retainedDecisions, rejected: plannerRejected, discarded: discardedDecisions}});
  for(const field of suggestionFields) if(proposed.has(field.id)) releaseDraftField(draftFieldKey(tabId,snapshot.frameId,field),snapshot.id);
  const immediateIds=new Set(immediateDraftFields.map(field=>field.id));
  const remainingDraftFields=suggestionFields.filter(field=>!proposed.has(field.id)&&!immediateIds.has(field.id))
    .sort((a,b)=>Number(a.type==='textarea')-Number(b.type==='textarea'));
  await Promise.all([immediateDraftPromise,generateDrafts(remainingDraftFields)]);
  await mutateRun(tabId,current=>{
    if(current.aiOperations?.[snapshot.operationKey]?.id!==snapshot.id)return false;
    current.aiOperations[snapshot.operationKey].status=plannerError?'failed':'completed';
    if(plannerError){current.aiOperations[snapshot.operationKey].error=plannerError;current.llmError=plannerError;}
    current.progress='ready';
  });
  await validatePageOnly(tabId);
  void tracePhoenixEvent('fill_page_result', {'ai.planner_error': Boolean(plannerError), 'ai.semantic_failure': semanticFailure,
    'ai.rejected_decision_count': plannerRejected.length}, sessionId, {traceContext, output: {plannerError, plannerRejected, semanticFailure}});
}
