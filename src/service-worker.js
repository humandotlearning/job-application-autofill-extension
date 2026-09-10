import { retrieveEvidence, savedFieldCandidates, searchEvidence, selectPlannerEvidence, rankSuggestionEvidence } from './retrieval.js';
import { inferSensitivity, isOpaqueIdentifier, validateFillValue, meaningCompatible, suggestionTargetKey } from './core.js';
import { callAnswerPlanner, callAnswerRewriter, callAnswerSuggestions, DEFAULT_FIREWORKS_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_PROVIDER } from './llm.js';
import { upsertAnswerRecords, mergeLearnedAnswers, normalizeAnswerRecord } from './core.js';
import {
  createDatasourceState,
  mergeDatasource,
  mergeAnswerRecords,
  parseDatasourceBackup,
  serializeDatasourceBackup,
  seedDatasource,
  shouldSeedDatasource,
} from './datasource.js';
import { exactVisibleChoice, planDeterministicFill, requiresVisibleChoiceMatch } from './form-engine.js';
import { buildLearningCandidates, callLearningReviewer } from './learning-review.js';

const RUN_STORAGE_KEY = 'applicationRun';
const MAX_PAGES = 20;
const ACTIVE_RUN_STATUSES = new Set(['running', 'waiting_user', 'page_ready', 'ready_for_user_submit']);
const SAVABLE_RUN_STATUSES = new Set(['waiting_user', 'page_ready', 'ready_for_user_submit', 'answers_saved']);
const processingTabs = new Set();
const backgroundJobs = new Map();
const WORKER_ID = `${Date.now()}:${Math.random()}`;
const saveLocks = new Set();
const saveOperations = new Map();
const reviewedCandidateCache = new WeakMap();
const MAX_DRAFT_CHARS = 4_000;
const MAX_REWRITE_INSTRUCTION_CHARS = 4_000;
let datasourceWriteChain = Promise.resolve();
let runWriteChain = Promise.resolve();
const INLINE_STORAGE_KEY = 'inlineFieldSessions';
const INLINE_TTL_MS = 10 * 60 * 1000;
let inlineWriteChain = Promise.resolve();
let datasourceInitPromise = null;

const APPLICATION_TITLE_PATTERN = /\b(?:apply|application|candidate|profile|resume|experience|education)\b/i;
const UTILITY_FRAME_PATTERN = /\b(?:search|cookie|job[\s-]?alerts?|talent[\s-]?communities?|subscribe|feedback)\b/i;
const NO_APPLICATION_FRAME_REASON = 'No unique application form frame was found. Complete the application manually.';
const AMBIGUOUS_APPLICATION_FRAME_REASON = 'More than one application form frame was found. Complete the application manually.';

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
  if (run && ((run.status === 'running' && run.workerId !== WORKER_ID) || Object.values(run.aiOperations || {}).some(op => op.status === 'pending' && op.workerId !== WORKER_ID))) {
    for (const op of Object.values(run.aiOperations || {})) if (op.status === 'pending' && op.workerId !== WORKER_ID) op.status = 'interrupted';
    run.status = 'waiting_user'; run.progress = 'ready'; run.waitingFor = 'operation_interrupted'; run.nextAction = null;
    run.actionRequired = [...(run.actionRequired || []).filter(item => item.reasonCode !== 'operation_interrupted'), { reasonCode: 'operation_interrupted', reason: 'The previous operation was interrupted. Check the page or retry AI.' }];
    await saveRun(run);
  }
  return run;
}

async function saveRun(run) {
  runWriteChain = runWriteChain.catch(() => {}).then(async () => {
    const runs = await getRuns();
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
}

async function loadSeedData() {
  if (typeof chrome.runtime?.getURL !== 'function') throw new Error('The bundled datasource URL is unavailable');
  const response = await fetch(chrome.runtime.getURL('data/seed-data.json'));
  if (!response.ok) throw new Error(`The bundled datasource could not be loaded (${response.status})`);
  return response.json();
}

async function initializeDatasource() {
  const stored = await chrome.storage.local.get({
    answerRecords: [],
    coverMessages: [],
    datasourceMeta: null,
    pendingLearnedAnswers: [],
    answerSource: '',
    sheetUrl: '',
    lastSyncedAt: '',
  });
  const legacyRecords = Array.isArray(stored.pendingLearnedAnswers)
    ? stored.pendingLearnedAnswers
    : [];
  const current = createDatasourceState({
    ...stored,
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
    const seeded = seedDatasource(await loadSeedData());
    await chrome.storage.local.set({
      answerRecords: seeded.answerRecords,
      coverMessages: seeded.coverMessages,
      datasourceMeta: seeded.datasourceMeta,
      profile: seeded.profile,
    });
    return seeded;
  }
  if (legacyRecords.length || !stored.datasourceMeta || !stored.profile) {
    current.datasourceMeta ||= { schemaVersion: current.schemaVersion, initializedAt: new Date().toISOString() };
    await chrome.storage.local.set({
      answerRecords: current.answerRecords,
      coverMessages: current.coverMessages,
      datasourceMeta: current.datasourceMeta,
      profile: current.profile,
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
  });
  return state;
}

async function queueLearningReview(records = []) {
  const current = await getDatasource();
  const inbox = Array.isArray(current.learningInbox) ? current.learningInbox : [];
  const candidates = buildLearningCandidates(records).filter(candidate => !current.answerRecords.some(record => record.key === candidate.id) && !inbox.some(item => item.candidate?.id === candidate.id));
  if (!candidates.length) return { queued: 0, error: '' };
  const settings = await getSettings();
  const apiKey = await getApiKey(settings.aiProvider);
  let proposals;
  let error = '';
  try {
    proposals = apiKey ? await callLearningReviewer({ apiKey, candidates }, { provider: settings.aiProvider, model: settings.aiModel }) : candidates.map(candidate => ({ candidateId: candidate.id, outcome: 'needs_user_label', canonicalKey: '', displayLabel: '', intent: 'other', valueKind: candidate.valueShape, aliases: [], topicTags: [], scope: candidate.scope, reusePolicy: 'never', confidence: 'low', classifier: { model: '', promptVersion: 'learning-review-v1', classifiedAt: new Date().toISOString() } }));
  } catch (caught) {
    error = caught.message;
    proposals = candidates.map(candidate => ({ candidateId: candidate.id, outcome: 'needs_user_label', canonicalKey: '', displayLabel: '', intent: 'other', valueKind: candidate.valueShape, aliases: [], topicTags: [], scope: candidate.scope, reusePolicy: 'never', confidence: 'low', classifier: { model: settings.aiModel, promptVersion: 'learning-review-v1', classifiedAt: new Date().toISOString() } }));
  }
  const now = new Date().toISOString();
  const byKey = new Map(records.map(record => [record.key, record]));
  const learningInbox = [...inbox, ...proposals.map(proposal => ({ id: `learning:${proposal.candidateId}:${Date.now()}`, status: 'pending', candidate: candidates.find(candidate => candidate.id === proposal.candidateId), record: byKey.get(proposal.candidateId), proposal, error, createdAt: now }))];
  await saveDatasource({ ...current, learningInbox, datasourceMeta: { ...(current.datasourceMeta || {}), schemaVersion: current.schemaVersion, updatedAt: now } });
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

async function persistLearnedRecords(records = [], run = null, { promote = false } = {}) {
  const now = new Date().toISOString();
  datasourceWriteChain = datasourceWriteChain.catch(() => {}).then(async () => {
    const current = await getDatasource();
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
      await chrome.storage.local.set({ applicationDrafts: drafts });
    }
    const scoped = scopeEmploymentRecords(promote ? learned : (changedRecords || learned), current.profile);
    // Mutation events are drafts only.  A deliberate Save promotes the exact
    // current values, which prevents delayed page events from overwriting a
    // correction the user just saved.
    const promotable = scoped
      .filter((record) => record.provenance !== 'autofill')
      .map((record) => ({ ...record, provenance: 'user', userEdited: true }));
    const answerRecords = promote
      ? mergeLearnedAnswers(current.answerRecords, promotable, now, { confirm: true })
      : current.answerRecords;
    const state = await saveDatasource({
      ...current,
      answerRecords,
      datasourceMeta: { ...(current.datasourceMeta || {}), schemaVersion: current.schemaVersion, updatedAt: now },
    });
    return { state, stats: saveStats(current.answerRecords, answerRecords, promote ? promotable : scoped) };
  });
  return datasourceWriteChain;
}

async function getRecords() {
  return (await getDatasource()).answerRecords.filter((record) => record.confirmationState !== 'pending' && (!record.alternatives?.length || record.confirmationState === 'confirmed'));
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
  const stored = await chrome.storage.local.get({ autoAdvancePages: false, aiProvider: '', aiModel: '', openaiModel: '', openaiApiKey: '', fireworksApiKey: '' });
  const aiProvider = stored.aiProvider === 'openai' || stored.aiProvider === 'fireworks'
    ? stored.aiProvider
    : (String(stored.openaiApiKey || '').trim() ? 'openai' : DEFAULT_PROVIDER);
  const fallbackModel = aiProvider === 'fireworks' ? DEFAULT_FIREWORKS_MODEL : DEFAULT_OPENAI_MODEL;
  const aiModel = String(stored.aiModel || (aiProvider === 'openai' ? stored.openaiModel : '') || fallbackModel).trim() || fallbackModel;
  return {
    autoAdvancePages: Boolean(stored.autoAdvancePages),
    aiProvider,
    aiModel,
    openaiModel: aiModel,
  };
}

async function datasourceSummary() {
  const state = await getDatasource();
  const learnedChanges = state.answerRecords
    .filter((record) => (record.history?.length || record.alternatives?.length || record.provenance === 'user' || record.confirmationState === 'pending'))
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
      .filter((record) => (record.history?.length || record.alternatives?.length || record.provenance === 'user' || record.confirmationState === 'pending'))
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

async function ensureContentScripts(tabId, frameIds) {
  if (!frameIds.length) return;
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

async function sendToFrame(tabId, frameId, message) {
  const targetFrameId = Number.isInteger(frameId) ? frameId : 0;
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId: targetFrameId });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [targetFrameId] },
      files: ['dist/content.js'],
    });
    return chrome.tabs.sendMessage(tabId, message, { frameId: targetFrameId });
  }
}

function frameInspectionText(context, inspection) {
  return [
    context.title,
    inspection?.page?.title,
    ...(inspection?.actions || []).map((action) => action.label || ''),
  ].join(' ');
}

function scoreApplicationFrame(context, inspection) {
  const fields = inspection?.fields || [];
  const actions = inspection?.actions || [];
  const requiredCount = fields.filter((field) => field.required).length;
  const applicationActions = actions.filter((action) => action.kind === 'next' || action.kind === 'submit').length;
  const applicationHint = APPLICATION_TITLE_PATTERN.test(frameInspectionText(context, inspection));
  const utilityText = [context.title, inspection?.page?.title].join(' ');
  const utilityHint = UTILITY_FRAME_PATTERN.test(utilityText);
  const score = fields.length + requiredCount * 3 + applicationActions * 40
    + (applicationHint ? 25 : 0) - (utilityHint ? 80 : 0);
  const eligible = fields.length > 0
    && !utilityHint
    && (applicationActions > 0 || (applicationHint && fields.length >= 2));
  return { score, eligible };
}

async function discoverApplicationFrame(tabId) {
  let contexts;
  try {
    contexts = await enumerateFrames(tabId);
  } catch {
    return {
      errorCode: 'no_application_frame',
      reason: NO_APPLICATION_FRAME_REASON,
    };
  }
  await ensureContentScripts(tabId, contexts.map((context) => context.frameId));
  const candidates = (await Promise.all(contexts.map(async (context) => {
    try {
      const response = await sendToFrame(tabId, context.frameId, { type: 'JOB_APP_INSPECT' });
      if (!response?.ok || !response.inspection) return null;
      const scoring = scoreApplicationFrame(context, response.inspection);
      return { ...context, inspection: response.inspection, ...scoring };
    } catch {
      return null;
    }
  }))).filter((candidate) => candidate?.eligible);

  if (!candidates.length) {
    return {
      errorCode: 'no_application_frame',
      reason: NO_APPLICATION_FRAME_REASON,
    };
  }
  candidates.sort((left, right) => right.score - left.score || left.frameId - right.frameId);
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
    return {
      errorCode: 'ambiguous_application_frame',
      reason: AMBIGUOUS_APPLICATION_FRAME_REASON,
    };
  }
  const selected = candidates[0];
  return {
    frameId: selected.frameId,
    context: { title: selected.title, pathname: selected.pathname },
    inspection: selected.inspection,
  };
}

function selectedFrame(run) {
  if (!Number.isInteger(run?.frame?.frameId)) throw new Error('No application form frame is selected');
  return run.frame.frameId;
}

function updateSelectedFrame(run, discovery) {
  run.frame = {
    frameId: discovery.frameId,
    title: discovery.context.title,
    pathname: discovery.context.pathname,
    domain: discovery.inspection?.page?.domain || '',
  };
  // Keep this alias for panel versions that predate the nested frame shape.
  run.frameId = discovery.frameId;
}

function frameRoutingError(discovery, cause) {
  const error = new Error(discovery.reason);
  error.frameDiscovery = discovery;
  error.cause = cause;
  return error;
}

async function sendToApplicationFrame(tabId, run, message) {
  const frameId = selectedFrame(run);
  try {
    return await sendToFrame(tabId, frameId, message);
  } catch (error) {
    let discovery;
    try {
      discovery = await discoverApplicationFrame(tabId);
    } catch {
      discovery = {
        errorCode: 'no_application_frame',
        reason: NO_APPLICATION_FRAME_REASON,
      };
    }
    if (discovery.errorCode) throw frameRoutingError(discovery, error);
    updateSelectedFrame(run, discovery);
    return sendToFrame(tabId, discovery.frameId, message);
  }
}

function pauseForFrame(run, discovery) {
  run.status = 'waiting_user';
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
  return run;
}

function nowRun(tabId) {
  const startedAt = new Date().toISOString();
  return {
    tabId,
    status: 'running',
    pageNumber: 1,
    pages: [],
    answers: [],
    actionRequired: [],
    optionalUnresolved: [],
    reviewRequired: [],
    audit: [],
    frame: null,
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

function profileEvidenceRecords(profile = {}) {
  const employment = Array.isArray(profile.employment) ? profile.employment : [];
  return employment.flatMap((entry, index) => {
    const company = String(entry?.company || '').trim();
    const roles = Array.isArray(entry?.roles) ? entry.roles : [];
    const companyRecord = company ? [{ key: `profile:employment:${entry.id || index}`, question: 'Confirmed employer', answer: company, provenance: 'profile', sensitivity: 'safe' }] : [];
    const roleRecords = roles.map((role, roleIndex) => {
      const title = String(role?.title || role?.role || '').trim();
      return title ? { key: `profile:employment:${entry.id || index}:role:${roleIndex}`, question: 'Employment role', answer: `${title}${company ? ` at ${company}` : ''}`, provenance: 'profile', sensitivity: 'safe' } : null;
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

async function recordPageCapture(run, inspection, pageRecords = [], { promote = false } = {}) {
  pageRecords = pageRecords.map(record => ({ ...record, pageNumber: run.pageNumber }));
  const saved = await persistLearnedRecords(pageRecords, run, { promote });
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
  const captured = await recordPageCapture(run, inspection, response?.records || []);
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
      ...(run.suggestions?.[field.id] ? { suggestion: run.suggestions[field.id], reason: 'Relevant saved evidence available — approve an answer before use' } : {}),
      ...(run.generatedSuggestions?.[field.id] ? { generatedSuggestion: run.generatedSuggestions[field.id], reason: 'AI drafts are ready for review before sending' } : {}),
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

async function applyPageDecisions(tabId, run, inspection, records, coverMessages, profile = {}, datasourceRevision = '', cycle = {pass: 0, deadline: Date.now() + 8000}) {
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
  if (pageOrOriginChanged) run.suggestions = {};
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
    }
    const scopedFields = resolveEmploymentFields(run, currentInspection.fields, profile);
    const validationResponse = await sendToApplicationFrame(tabId, run, { type: 'JOB_APP_VALIDATE' });
    currentValidation = validationResponse?.validation || { ok: false, requiredEmpty: [], invalid: [] };
    const invalidFieldIds = new Set((currentValidation.invalid || []).map((field) => field.fieldId));
    const localDecisions = planDeterministicFill(scopedFields, records, coverMessages, profile, currentInspection.page).map(decision => {
      const field = scopedFields.find(field => field.id === decision.fieldId);
      if (!field) return decision;
      if (field.entityUnresolved) return {...decision, action:'ask_user',value:null,disposition:'manual',reason:'Choose the employer for this work-history section'};
      // An existing invalid value must not be silently replaced by deterministic
      // autofill. Keep it unresolved so planner output can be reviewed first.
      if (String(field.currentValue || '').trim() && invalidFieldIds.has(field.id)) {
        return { ...decision, action: 'keep', value: null, reason: 'The current value does not satisfy the field constraints' };
      }
      if (String(field.currentValue || '').trim()) return decision;
      const candidates = savedFieldCandidates(field, records, draftRecords);
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
    const localResult = await sendToApplicationFrame(tabId, run, { type: 'JOB_APP_APPLY', decisions: fillable, deadline: cycle.deadline, applicationId: run.startedAt });
    if (!localResult?.ok) throw new Error(localResult?.error || 'The page rejected local answers');
    appliedReviews.push(...(localResult.result?.reviewRequired || []));
    unresolvedResults.push(...(localResult.result?.unresolved || []));
    const refreshed = await sendToApplicationFrame(tabId, run, { type: 'JOB_APP_INSPECT' });
    currentInspection = refreshed.inspection;
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
    const inspected = await sendToFrame(tabId, message.frameId, { type: 'JOB_APP_INSPECT' });
    const field = resolveEmploymentFields(run, inspected.inspection?.fields || [], (await getDatasource()).profile).find(item => item.id === fieldId);
    if (!field || field.handle !== message.handle || field.currentValue || JSON.stringify(field.options) !== JSON.stringify(suggestion.field.options)
      || field.label !== suggestion.field.label || field.type !== suggestion.field.type
      || pageSignature(inspected.inspection, run.frame) !== message.pageSignature) throw new Error('Destination changed; check the page again');
    const applied = await applyReviewedField({
      tabId, frameId: message.frameId, applicationId: run.startedAt, field, suggestion, message, approvalGuard: null,
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
  return {ok: true, sessionId: session.sessionId, requestId, field: session.field,
    candidates: session.suggestions?.[session.field?.id]?.candidates || [],
    generatedSuggestion: session.generatedSuggestions?.[session.field?.id] || null, ...extra};
}

function compatibleInlineRun(run, inspection, field, frameId) {
  if (!run || !SAVABLE_RUN_STATUSES.has(run.status) || run.frame?.frameId !== frameId
    || pageSignature(inspection, run.frame) !== run.pageSignature) return null;
  const prior = run.suggestions?.[field.id]?.field || run.generatedSuggestions?.[field.id]?.field;
  if (!(prior ? field.handle === prior.handle && sameFieldSnapshot(field, aiFieldSnapshot(prior))
    : run.fieldStates?.[field.id]?.handle === field.handle)) return null;
  return run;
}

async function inspectInlineDestination(origin, {fieldId, handle, requireFocus = true}) {
  const response = await sendToFrame(origin.tabId, origin.frameId, {type: 'JOB_APP_INSPECT_INLINE', fieldId, handle, requireFocus});
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
  if (processingTabs.has(origin.tabId) || saveLocks.has(origin.tabId)) throw new Error('Application is busy or unavailable');
  // Reserve first: a later focus query or navigation must revoke this operation even while inspection awaits.
  const reserved = await mutateInlineSession(origin.tabId, origin.frameId, null, () => ({...origin,
    sessionId: crypto.randomUUID(), field: null, suggestions: {}, generatedSuggestions: {},
    generation: {status: 'idle', requestId: crypto.randomUUID()}, attachedRun: null, panelRequested: false}));
  const {inspection, field} = await inspectInlineDestination(origin, message);
  const scoped = await scopeInlineField(origin, inspection, field);
  const [records, drafts] = await Promise.all([getRecords(), draftEvidenceRecords()]);
  const candidates = scoped.field.entityUnresolved ? [] : savedFieldCandidates(scoped.field, records, drafts);
  const current = await inspectInlineDestination(origin, message);
  if (pageSignature(current.inspection) !== pageSignature(inspection) || !sameFieldSnapshot(current.field, aiFieldSnapshot(field))
    || current.field.editRevision !== field.editRevision) throw new Error('Inline destination changed. Focus the field again.');
  const session = await mutateInlineSession(origin.tabId, origin.frameId, reserved.sessionId, currentSession => {
    const savedCandidates = candidates.map(candidate => ({...candidate, candidateId: `${currentSession.revision + 1}:${crypto.randomUUID()}`}));
    const signature = pageSignature(inspection);
    return {...currentSession, field: scoped.field, pageSignature: signature, jobContext: inspection.page,
      attachedRun: scoped.attachedRun, suggestions: {[field.id]: {...origin, applicationId: scoped.attachedRun?.applicationId || reserved.sessionId,
        pageSignature: signature, field: scoped.field, candidates: savedCandidates}}};
  });
  return inlineReply(session, message.requestId, scoped.field.entityUnresolved ? {error: 'Choose the employer for this work-history section'} : {});
}

async function guardInlineField(message, sender, {requireFocus = true} = {}) {
  const origin = inlineOrigin(message, sender);
  const session = await writeInlineSessions(sessions => sessions[`${origin.tabId}:${origin.frameId}`]);
  if (!session || session.sessionId !== message.sessionId || !session.field
    || Object.keys(origin).some(key => session[key] !== origin[key])) throw new Error('Inline session expired or destination changed');
  const destination = {fieldId: session.field.id, handle: session.field.handle, pageSignature: session.pageSignature,
    applicationId: session.attachedRun?.applicationId || session.sessionId};
  if (Object.keys(destination).some(key => Object.hasOwn(message, key) && message[key] !== destination[key])) throw new Error('Inline destination origin does not match the session');
  const {inspection, field} = await inspectInlineDestination(origin, {fieldId: session.field.id, handle: session.field.handle, requireFocus});
  if (pageSignature(inspection) !== session.pageSignature || !sameFieldSnapshot(field, aiFieldSnapshot(session.field))
    || field.editRevision !== session.field.editRevision || field.rawValue !== session.field.rawValue) throw new Error('Inline destination changed');
  const scoped = await scopeInlineField(origin, inspection, field);
  if (scoped.field.entityUnresolved || ['entityId', 'entityType', 'employmentId'].some(key => scoped.field[key] !== session.field[key])) {
    throw new Error('Choose the employer for this work-history section');
  }
  if (session.attachedRun && JSON.stringify(scoped.attachedRun) !== JSON.stringify(session.attachedRun)) throw new Error('The application changed. Focus the field again.');
  const latest = await writeInlineSessions(sessions => sessions[`${origin.tabId}:${origin.frameId}`]);
  if (!latest || latest.sessionId !== session.sessionId || latest.revision !== session.revision) throw new Error('Inline session changed');
  return {session: latest, inspection, field: scoped.field};
}

async function acceptInlineField(message, sender) {
  const origin = inlineOrigin(message, sender);
  if (processingTabs.has(origin.tabId) || saveLocks.has(origin.tabId)) throw new Error('Application is busy or unavailable');
  saveLocks.add(origin.tabId);
  let session;
  let result;
  try {
    ({session} = await guardInlineField(message, sender, {requireFocus: false}));
    const suggestion = session.suggestions?.[session.field.id];
    const candidate = suggestion?.candidates.find(item => item.candidateId === message.candidateId);
    if (!candidate) throw new Error('Inline candidate expired. Focus the field again.');
    // Only worker-stored candidate keys/answers authorize the shared reviewed write.
    const approval = {sourceKeys: sourceKeysForCandidate(candidate)};
    await reviewedCandidate(suggestion, approval);
    const guarded = await guardInlineField(message, sender, {requireFocus: false});
    if (guarded.session.revision !== session.revision) throw new Error('Inline session changed');
    // A fresh approval object avoids reusing the preflight evidence cache across the awaited guard.
    await applyReviewedField({tabId: origin.tabId, frameId: origin.frameId, applicationId: session.attachedRun?.applicationId,
      field: guarded.field, suggestion, message: {sourceKeys: sourceKeysForCandidate(candidate)},
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

// Completed suggestions survive worker suspension; foreign pending jobs cannot silently succeed.
writeInlineSessions(() => null).catch(() => {});

function listedRunField(run, fieldId) {
  return [...(run.actionRequired || []), ...(run.optionalUnresolved || [])]
    .find((item) => item?.fieldId === fieldId) || null;
}

function sameFieldSnapshot(field, snapshot = {}) {
  if (!snapshot || typeof snapshot !== 'object') return true;
  if (snapshot.handle && field.handle !== snapshot.handle) return false;
  if (snapshot.label && field.label !== snapshot.label) return false;
  if (snapshot.fieldType && field.type !== snapshot.fieldType) return false;
  if (snapshot.fieldOptions && JSON.stringify(field.options || []) !== JSON.stringify(snapshot.fieldOptions)) return false;
  if (snapshot.fieldConstraints && JSON.stringify(field.constraints || {}) !== JSON.stringify(snapshot.fieldConstraints)) return false;
  if (snapshot.fieldMultiple != null && Boolean(field.multiple) !== Boolean(snapshot.fieldMultiple)) return false;
  return true;
}

async function guardedDraftField(message, { allowSaveLock = false } = {}) {
  const { tabId, fieldId } = message;
  if (!Number.isInteger(tabId) || !fieldId || typeof fieldId !== 'string') throw new Error('The application field is unavailable');
  if (processingTabs.has(tabId) || (!allowSaveLock && saveLocks.has(tabId))) throw new Error('Application is busy or unavailable');
  const run = await getRun(tabId);
  const listed = listedRunField(run, fieldId);
  const suggestion = run?.suggestions?.[fieldId] || null;
  if (!run || !listed || !SAVABLE_RUN_STATUSES.has(run.status)
    || message.frameId !== run.frame?.frameId || message.applicationId !== run.startedAt
    || message.pageSignature !== run.pageSignature || !message.handle || message.handle !== listed.handle) {
    throw new Error('Stale draft; check the page again');
  }
  // Never rediscover/reroute a draft operation into another frame.
  const inspected = await sendToFrame(tabId, message.frameId, { type: 'JOB_APP_INSPECT' });
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
    const validation = await sendToFrame(tabId, message.frameId, { type: 'JOB_APP_VALIDATE' });
    if (!validation?.validation?.invalid?.some((item) => item.fieldId === fieldId)) {
      throw new Error('Destination changed; check the page again');
    }
  }
  return { run, listed, suggestion, field };
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
  const records = candidate?.kind === 'draft' ? await draftEvidenceRecords() : await getRecords();
  const sources = sourceKeys.map((key) => records.find((record) => record.key === key));
  const compatibleEvidence = candidate?.kind === 'planner'
    ? rankSuggestionEvidence(suggestion.field, records, {limit: records.length})
    : retrieveEvidence(suggestion.field, records, {limit: records.length});
  if (!candidate || !sourceKeys.length || sources.some((source) => !source)
    || sources.some((source) => source.answer !== sourceAnswerSnapshot(candidate, source.key))
    || sources.some((source) => !compatibleEvidence.some((item) => (item.sourceKey || item.key) === source.key))) {
    throw new Error('Saved evidence changed; check again');
  }
  const result = { candidate, sourceKeys, sources, compatibleEvidence };
  reviewedCandidateCache.set(message, { suggestion, result });
  return result;
}

async function applyReviewedField({ tabId, frameId, applicationId, field, suggestion, message, approvalGuard }) {
  let candidate = null;
  let sourceKeys = [];
  let sources = [];
  let compatibleEvidence = [];
  if (suggestion) {
    ({ candidate, sourceKeys, sources, compatibleEvidence } = await reviewedCandidate(suggestion, message));
  }
  const value = candidate ? String(message.answer ?? candidate.answer).trim() : String(message.answer);
  const validation = validateFillValue(field, value);
  const sourceCompatible = !candidate || (candidate.kind === 'planner'
    ? sources.every((item) => compatibleEvidence.some((evidence) => (evidence.sourceKey || evidence.key) === item.key))
    : meaningCompatible(field, sources[0], { numericReview: !(['textarea', 'text'].includes(field.type) && value === candidate.answer) }));
  if (!validation.ok || !sourceCompatible || inferSensitivity(field.label, field.id) === 'legal' || field.type === 'checkbox') {
    throw new Error(validation.ok ? 'This destination requires manual entry' : validation.reason);
  }
  const result = await sendToFrame(tabId, frameId, {
    type: 'JOB_APP_APPLY',
    applicationId,
    ...(approvalGuard ? {approvalGuard} : {}),
    decisions: [{
      fieldId: field.id,
      handle: field.handle,
      action: 'fill',
      approved: true,
      value,
      evidenceKeys: sourceKeys,
      sensitivity: inferSensitivity(field.label, field.id),
      confidence: 'high',
      reason: candidate ? 'Explicitly approved saved answer' : 'Explicitly entered draft answer',
      ...(approvalGuard || {}),
    }],
  });
  if (!result?.ok) throw new Error(result?.error || 'Could not apply the answer');
  const verified = await sendToFrame(tabId, frameId, { type: 'JOB_APP_INSPECT' });
  if (verified.inspection?.fields.find((item) => item.id === field.id && item.handle === field.handle)?.currentValue !== value) {
    throw new Error(candidate ? 'The page did not retain the approved answer' : 'The page did not retain the entered answer');
  }
  if (candidate) {
    const source = sources[0];
    datasourceWriteChain = datasourceWriteChain.catch(() => {}).then(async () => {
      const state = await getDatasource();
      const latestRecords = candidate.kind === 'draft' ? await draftEvidenceRecords() : state.answerRecords;
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
  const validationResponse = await sendToFrame(tabId, frameId, { type: 'JOB_APP_VALIDATE' });
  return { inspection: verified.inspection, validation: validationResponse?.validation || {}, value };
}

async function rewriteEvidence(suggestion, message) {
  const requestedKeys = sourceKeysFromMessage(message);
  if (!requestedKeys.length) return [];
  const candidate = suggestion?.candidates?.find((item) => sameKeys(sourceKeysForCandidate(item), requestedKeys));
  if (!candidate) throw new Error('Saved evidence changed; choose an answer again');
  const records = candidate.kind === 'draft' ? await draftEvidenceRecords() : await getRecords();
  const relevant = records.filter((record) => requestedKeys.includes(record.key));
  if (relevant.length !== requestedKeys.length
    || relevant.some((record) => !retrieveEvidence(suggestion.field, records, {limit: records.length}).some((item) => item.sourceKey === record.key))) {
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
    });
    categorizeRun(run, applied.inspection, applied.validation);
    return { ok: true, run: await saveRun(run) };
  } finally {
    saveLocks.delete(tabId);
  }
}

async function rewriteAnswer(message) {
  const draft = requiredBoundedText(message.draft, 'Draft answer', MAX_DRAFT_CHARS);
  const instruction = requiredBoundedText(message.instruction, 'Rewrite instruction', MAX_REWRITE_INSTRUCTION_CHARS);
  const { suggestion, field } = await guardedDraftField(message);
  const settings = await getSettings();
  const apiKey = await getApiKey(settings.aiProvider);
  if (!apiKey) throw new Error(`Add a ${settings.aiProvider === 'fireworks' ? 'Fireworks' : 'OpenAI'} API key before requesting a rewrite`);
  const records = await rewriteEvidence(suggestion, message);
  const rewritten = await callAnswerRewriter({
    apiKey,
    question: field.label,
    draft,
    instruction,
    records,
    page: (await getRun(message.tabId))?.jobContext || {},
  }, { provider: settings.aiProvider, model: settings.aiModel });
  return { ok: true, answer: requiredBoundedText(rewritten.answer, 'Rewritten answer', MAX_DRAFT_CHARS) };
}

async function generateFieldDrafts({ field, inspection, jobContext, datasource, records, settings, apiKey }) {
  const pageRecords = (inspection?.fields || [])
    .filter((item) => item.currentValue && readableQuestion(item))
    .map((item) => ({ key: `page:${item.id}`, question: item.label, answer: item.currentValue, provenance: 'current application page', sensitivity: inferSensitivity(item.label, item.id) }));
  return callAnswerSuggestions({
    apiKey,
    field,
    page: jobContext,
    records: rankSuggestionEvidence(field, [...records, ...profileEvidenceRecords(datasource.profile), ...pageRecords], {limit:40}),
  }, { provider: settings.aiProvider, model: settings.aiModel });
}

async function generateSuggestions(message) {
  const jobDescription = message.jobDescription == null || (typeof message.jobDescription === 'string' && !message.jobDescription.trim())
    ? ''
    : requiredBoundedText(message.jobDescription, 'Job description', 16_000);
  const { run, field } = await guardedDraftField(message);
  if (!readableQuestion(field)) throw new Error('The form question is unclear. Use Show on page and enter the answer manually.');
  const settings = await getSettings();
  const apiKey = await getApiKey(settings.aiProvider);
  if (!apiKey) throw new Error(`Add a ${settings.aiProvider === 'fireworks' ? 'Fireworks' : 'OpenAI'} API key before generating answer suggestions`);
  const [records, datasource, inspected] = await Promise.all([getRecords(), getDatasource(), sendToFrame(message.tabId, message.frameId, { type: 'JOB_APP_INSPECT' })]);
  const jobContext = mergeJobContext(run.jobContext, inspected.inspection?.page);
  if (jobDescription) jobContext.jobDescription = jobDescription;
  const snapshot = suggestionRequestSnapshot(run, field, inspected.inspection, datasource, settings, jobContext);
  const generated = await generateFieldDrafts({ field, inspection: inspected.inspection, jobContext, datasource, records, settings, apiKey });
  const validation = await sendToFrame(message.tabId, message.frameId, { type: 'JOB_APP_VALIDATE' });
  const current = await currentSuggestionDestination(message.tabId, snapshot);
  if (!current) throw new Error('The page or supporting evidence changed. Generate again.');
  const updated = await mutateRun(message.tabId, (run) => {
    if (!sameSuggestionRun(run, snapshot)) return false;
    run.jobContext = jobContext;
    run.generatedSuggestions = run.generatedSuggestions || {};
    run.generatedSuggestions[field.id] = {
      tabId: message.tabId, frameId: message.frameId, applicationId: run.startedAt, pageSignature: run.pageSignature,
      field, suggestions: generated.suggestions, missingContext: generated.missingContext,
    };
    categorizeRun(run, current.inspection, validation?.validation || {});
  });
  if (!updated) throw new Error('The page or supporting evidence changed. Generate again.');
  return { ok: true, run: updated };
}

function hasBlockingIssues(run, validation) {
  return Boolean(run.actionRequired.length || !validation.ok);
}

async function processPage(tabId, { autoAdvance } = { autoAdvance: false }) {
  if (processingTabs.has(tabId)) return getRun(tabId);
  processingTabs.add(tabId);
  try {
    let run = await getRun(tabId);
    if (!run || run.status !== 'running') return run;
    if (run.pageNumber > MAX_PAGES) {
      run.status = 'waiting_user';
      run.waitingFor = 'page_limit_exceeded';
      run.actionRequired = [{ reason: 'The application exceeded the 20-page automatic limit.' }];
      run.nextAction = null;
      return await saveRun(run);
    }

    const [records, coverMessages, datasource] = await Promise.all([
      getRecords(),
      getCoverMessages(),
      getDatasource(),
    ]);
    const discovery = await discoverApplicationFrame(tabId);
    if (discovery.errorCode) return await saveRun(pauseForFrame(run, discovery));
    updateSelectedFrame(run, discovery);
    const processed = await applyPageDecisions(
      tabId,
      run,
      discovery.inspection,
      records,
      coverMessages,
      datasource.profile,
      datasource.datasourceMeta?.updatedAt || '',
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
  const current = await getRun(tabId);
  if (current && ACTIVE_RUN_STATUSES.has(current.status)) {
    if (current.status !== 'running') return current;
    const settings = await getSettings();
    return processPage(tabId, { autoAdvance: settings.autoAdvancePages });
  }
  const run = await saveRun(nowRun(tabId));
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
  let clicked;
  try {
    clicked = await sendToApplicationFrame(tabId, run, {
      type: 'JOB_APP_CLICK_NEXT',
      actionId: run.nextAction.id,
    });
  } catch (error) {
    if (!error.frameDiscovery) throw error;
    return { ok: false, error: error.message, run: await saveRun(pauseForFrame(run, error.frameDiscovery)) };
  }
  if (!clicked?.ok) {
    run.status = 'waiting_user';
    run.waitingFor = 'ambiguous_navigation';
    run.actionRequired = [{ reason: clicked?.error || 'The Next control could not be activated' }];
    run.nextAction = null;
    return { ok: false, error: run.actionRequired[0].reason, run: await saveRun(run) };
  }
  run.pageNumber += 1;
  run.status = 'running';
  run.lastAction = 'next';
  run.waitingFor = null;
  run.waitingLabel = null;
  run.nextAction = null;
  return { ok: true, run: await saveRun(run) };
}

async function focusRunField(tabId, fieldId) {
  if (!fieldId) throw new Error('A fieldId is required');
  const run = await getRun(tabId);
  if (!run) return { ok: false, run: null };
  const discovery = await discoverApplicationFrame(tabId);
  if (discovery.errorCode) return { ok: false, run: await saveRun(pauseForFrame(run, discovery)) };
  updateSelectedFrame(run, discovery);
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
    if (!run || !SAVABLE_RUN_STATUSES.has(run.status)) {
      return { ok: false, error: 'The current page is not ready to save answers' };
    }
    const discovery = await discoverApplicationFrame(tabId);
    if (discovery.errorCode) return { ok: false, error: discovery.reason, run: await saveRun(pauseForFrame(run, discovery)) };
    updateSelectedFrame(run, discovery);
    const inspection = discovery.inspection;
    const captured = await sendToApplicationFrame(tabId, run, { type: 'JOB_APP_CAPTURE' });
    return await saveCapturedAnswers(run, inspection, captured.records || []);
  } catch (error) {
    if (!error.frameDiscovery) throw error;
    return { ok: false, error: error.message, run: await saveRun(pauseForFrame(run, error.frameDiscovery)) };
  } finally {
    finishSave();
  }
}

async function saveCapturedAnswers(run, inspection, records) {
  const result = await recordPageCapture(run, inspection, records, { promote: false });
  const learning = await queueLearningReview(records);
  run = result.run;
  if (run.status === 'ready_for_user_submit') {
    run.status = 'answers_saved';
    run.waitingFor = null;
    run.waitingLabel = null;
  }
  return { ok: true, run: await saveRun(run), ...result.stats, learningQueued: learning.queued, learningError: learning.error };
}

async function saveFinalSubmission(message, sender) {
  const tabId = sender?.tab?.id;
  const frameId = Number.isInteger(sender?.frameId) ? sender.frameId : 0;
  if (!Number.isInteger(tabId) || !Array.isArray(message.records)) return { ok: false, error: 'The submitted application snapshot is unavailable' };
  const acceptedRun = await getRun(tabId);
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
    const previousPage = finalRun.pages?.find((page) => page.pageNumber === finalRun.pageNumber);
    const page = message.page && typeof message.page === 'object' ? message.page : (previousPage?.page || finalRun.jobContext || {});
    return await saveCapturedAnswers(finalRun, { page }, message.records);
  } finally {
    finishSave();
  }
}

function matchesFinalSubmission(run, message, sender, frameId) {
  if (!run || !['ready_for_user_submit', 'answers_saved'].includes(run.status)
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
  if (['JOB_INLINE_QUERY', 'JOB_INLINE_ACCEPT', 'JOB_INLINE_CANCEL'].includes(message?.type)) {
    (async () => {
      if (message.type === 'JOB_INLINE_QUERY') return queryInlineField(message, sender);
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
      if(!run || message.applicationId!==run.startedAt || (sender.frameId??0)!==run.frame?.frameId) return {ok:false};
      if(sender.url){const url=new URL(sender.url);if(url.hostname!==run.frame.domain || (run.frame.pathname && url.pathname!==run.frame.pathname))return {ok:false};}
      return {ok:true,run:await validatePageOnly(tabId)};
    })().then(sendResponse).catch(error=>sendResponse({ok:false,error:error.message}));return true;
  }
  if (message?.type === 'JOB_APP_FINAL_SUBMISSION') {
    saveFinalSubmission(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'JOB_APP_LEARN' || message?.type === 'JOB_APP_LEARNING_STATUS') {
    (async () => {
      const tabId = sender?.tab?.id;
      const run = tabId ? await getRun(tabId) : null;
      if (!run || ![...ACTIVE_RUN_STATUSES, 'answers_saved'].includes(run.status) || run.frame?.frameId !== (sender.frameId ?? 0)) return { ok: false };
      if (sender.url) {
        const url = new URL(sender.url);
        if (run.frame.domain && url.hostname !== run.frame.domain) return { ok: false };
        if (run.frame.pathname && url.pathname !== run.frame.pathname) {
          const discovery = await discoverApplicationFrame(tabId);
          if (discovery.errorCode || discovery.frameId !== (sender.frameId ?? 0) || discovery.context.pathname !== url.pathname) return { ok: false };
          updateSelectedFrame(run, discovery);
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
      await persistLearnedRecords(message.records, run);
      return { ok: true };
    })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'JOB_APP_NAVIGATED') {
    const tabId = sender?.tab?.id;
    (async () => {
      if (Number.isInteger(tabId)) await invalidateInlineSessions(tabId, Number.isInteger(sender.frameId) ? sender.frameId : 0);
      const run = tabId ? await getRun(tabId) : null;
      const senderFrameId = Number.isInteger(sender?.frameId) ? sender.frameId : 0;
      if (run?.status !== 'running' || run.lastAction !== 'next') return { ok: true, run };
      if (!Number.isInteger(run.frame?.frameId) || run.frame.frameId !== senderFrameId) return { ok: true, run };
      const settings = await getSettings();
      return { ok: true, run: await processPage(tabId, { autoAdvance: settings.autoAdvancePages }) };
    })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (![
    'JOB_RUN_APPROVE_SUGGESTION',
    'JOB_RUN_APPLY_DRAFT',
    'JOB_RUN_REWRITE_ANSWER',
    'JOB_RUN_GENERATE_SUGGESTIONS',
    'JOB_RUN_START',
    'JOB_RUN_CHECK_PAGE',
    'JOB_RUN_ADVANCE_PAGE',
    'JOB_RUN_FOCUS_FIELD',
    'JOB_RUN_SAVE_ANSWERS',
    'JOB_RUN_VALIDATE_PAGE',
    'JOB_RUN_RETRY_AI',
    'JOB_RUN_SELECT_EMPLOYMENT',
    'JOB_RUN_SEARCH_ANSWERS',
    'JOB_RUN_STATE',
    'JOB_DATASOURCE_STATE',
    'JOB_DATASOURCE_EXPORT',
    'JOB_DATASOURCE_IMPORT',
    'JOB_DATASOURCE_CORRECT',
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
    if (message.type === 'JOB_DATASOURCE_EXPORT') return { ok: true, backup: serializeDatasourceBackup(await getDatasource()) };
    if (message.type === 'JOB_DATASOURCE_IMPORT') {
      const state = await importDatasourceBackup(message.backup);
      return {
        ok: true,
        datasource: {
          schemaVersion: state.schemaVersion,
          answerCount: state.answerRecords.length,
          coverMessageCount: state.coverMessages.length,
          learnedChanges: state.answerRecords
            .filter((record) => (record.history?.length || record.alternatives?.length))
            .map((record) => ({
              key: record.key,
              question: record.question,
              answer: record.answer,
              history: record.history || [],
              alternatives: record.alternatives || [],
              entityId: record.entityId || '',
              context: record.context || '',
              confirmedAt: record.confirmedAt || null,
            })),
        },
      };
    }
    if (message.type === 'JOB_DATASOURCE_CORRECT') {
      return { ok: true, datasource: await correctDatasourceRecord(message.key, message.answer) };
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
    if (message.type === 'JOB_RUN_VALIDATE_PAGE') return { ok: true, run: await validatePageOnly(tabId) };
    if (message.type === 'JOB_RUN_RETRY_AI') { await scheduleAi(tabId, { retry: true }); return { ok: true, run: await getRun(tabId) }; }
    if (message.type === 'JOB_RUN_SELECT_EMPLOYMENT') return selectEmployment(message);
    if (message.type === 'JOB_RUN_SEARCH_ANSWERS') return searchSavedAnswers(message);
    if (message.type === 'JOB_RUN_STATE') return { ok: true, run: await getRun(tabId) };
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
  if (changeInfo.url || ['loading', 'complete'].includes(changeInfo.status)) invalidateInlineSessions(tabId).catch(() => {});
  if (changeInfo.status !== 'complete') return;
  getRun(tabId)
    .then(async (run) => {
      if (run?.status !== 'running' || run.waitingFor === 'operation_interrupted') return;
      run.frame = null;
      await saveRun(run);
      const settings = await getSettings();
      await processPage(tabId, { autoAdvance: settings.autoAdvancePages });
    })
    .catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  invalidateInlineSessions(tabId).catch(() => {});
  removeRun(tabId).catch(() => {});
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await chrome.storage.session.clear();
  const settings = await chrome.storage.local.get({ autoAdvancePages: false });
  await chrome.storage.local.set({ autoAdvancePages: Boolean(settings.autoAdvancePages) });
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
    if (!current || change(current) === false) { result = null; return; }
    result = {...current, revision:(current.revision || 0)+1,workerId:WORKER_ID,updatedAt:new Date().toISOString()};
    runs[String(tabId)] = result;
    await chrome.storage.session.set({[RUN_STORAGE_KEY]:runs});
  });
  await runWriteChain;
  return result;
}

async function validatePageOnly(tabId) {
  const run = await getRun(tabId);
  if (!run || processingTabs.has(tabId) || saveLocks.has(tabId)) return run;
  const inspected = await sendToApplicationFrame(tabId, run, {type:'JOB_APP_INSPECT'});
  const validated = await sendToApplicationFrame(tabId, run, {type:'JOB_APP_VALIDATE'});
  if (!inspected?.ok || !validated?.ok) throw new Error('The page could not be checked. Try Check again.');
  const inspection = inspected.inspection;
  return mutateRun(tabId, current => {
    if (current.startedAt !== run.startedAt || current.frame?.frameId !== run.frame?.frameId) return false;
    const signature = pageSignature(inspection,current.frame);
    if (signature !== current.pageSignature) {
      current.pageSignature=signature; current.suggestions={}; current.generatedSuggestions={};
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
    categorizeRun(current,inspection,validated.validation);
    const next=inspection.actions.filter(action=>action.kind==='next');
    const submit=inspection.actions.filter(action=>action.kind==='submit');
    current.nextAction=null;
    if(hasBlockingIssues(current,validated.validation)) {current.status='waiting_user';current.waitingFor=current.actionRequired[0]?.reason || 'invalid_field';}
    else if(next.length===1) {current.status='page_ready';current.nextAction=next[0];current.waitingFor=null;}
    else if(submit.length===1) {current.status='ready_for_user_submit';current.waitingFor=null;}
    else {current.status='waiting_user';current.waitingFor='ambiguous_navigation';}
    current.progress=Object.values(current.aiOperations || {}).some(op=>op.status==='pending')?'preparing_suggestions':'ready';
  });
}

async function selectEmployment(message) {
  const run=await getRun(message.tabId);
  if(!run || processingTabs.has(message.tabId) || saveLocks.has(message.tabId) || run.startedAt!==message.applicationId || run.pageSignature!==message.pageSignature || run.frame?.frameId!==message.frameId) throw new Error('Work-history section changed. Check the page again.');
  const profile=(await getDatasource()).profile;
  if(!profile.employment.some(entry=>entry.id===message.employmentId)) throw new Error('Saved employer is unavailable. Update your profile.');
  const inspected=await sendToFrame(message.tabId,message.frameId,{type:'JOB_APP_INSPECT'});
  if(pageSignature(inspected.inspection,run.frame)!==run.pageSignature || !inspected.inspection.fields.some(field=>field.entityType==='employment' && field.entityId===message.sectionId)) throw new Error('Work-history section changed. Check the page again.');
  run.employmentMappings ||= {};
  run.employmentMappings[`${run.pageSignature}:${message.sectionId}`]=message.employmentId;
  await saveRun(run);
  return {ok:true,run:await checkPage(message.tabId)};
}

async function searchSavedAnswers(message) {
  const {run,field}=await guardedDraftField(message);
  const records=await getRecords();
  const query=String(message.query || '').trim().toLowerCase().slice(0,200);
  const candidates=searchEvidence(field,records,{limit:20}).filter(item=>!query || `${item.sourceQuestion} ${item.answer}`.toLowerCase().includes(query));
  const updated=await mutateRun(message.tabId,current=>{
    if(current.startedAt!==run.startedAt || current.pageSignature!==run.pageSignature) return false;
    current.suggestions ||= {};
    current.suggestions[field.id]={tabId:message.tabId,frameId:message.frameId,applicationId:run.startedAt,pageSignature:run.pageSignature,field,candidates};
    for(const item of [...(current.actionRequired||[]),...(current.optionalUnresolved||[])]) if(item.fieldId===field.id) item.suggestion=current.suggestions[field.id];
  });
  if(!updated) throw new Error('The application changed. Search again.');
  return {ok:true,candidates,run:updated};
}

function aiFieldSnapshot(field = {}) {
  return {
    id: field.id,
    handle: field.handle,
    label: field.label,
    fieldType: field.type,
    currentValue: field.currentValue,
    fieldOptions: field.options || [],
    fieldConstraints: field.constraints || {},
    fieldMultiple: Boolean(field.multiple),
  };
}

function aiEvidenceRevision(run, inspection, datasource) {
  return JSON.stringify({
    context: run.jobContext || {},
    profile: datasource?.profile || {},
    records: datasource?.answerRecords || [],
    pageFacts: (inspection?.fields || []).map((field) => aiFieldSnapshot(field)),
  });
}

function aiFingerprint(run, fields, settings, evidenceRevision) {
  return JSON.stringify({applicationId:run.startedAt,frame:run.frame?.frameId,page:run.pageSignature,fields:fields.map(({id,handle,entityId,employmentId})=>({id,handle,entityId,employmentId})),evidenceRevision,provider:settings.aiProvider,model:settings.aiModel,promptVersion:'reliable-review-1'});
}

function suggestionRequestSnapshot(run, field, inspection, datasource, settings, jobContext) {
  const contextualRun = { ...run, jobContext };
  return {
    startedAt: run.startedAt,
    runRevision: Number(run.revision) || 0,
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
    && Number(run.revision || 0) === snapshot.runRevision
    && run.pageSignature === snapshot.pageSignature
    && run.frame?.frameId === snapshot.frameId
    && SAVABLE_RUN_STATUSES.has(run.status)
    && JSON.stringify(run.jobContext || {}) === JSON.stringify(snapshot.sourceJobContext || {}));
}

async function currentSuggestionDestination(tabId, snapshot) {
  const run = await getRun(tabId);
  if (!sameSuggestionRun(run, snapshot)) return null;
  const settings = await getSettings();
  if (settings.aiProvider !== snapshot.settings.aiProvider || settings.aiModel !== snapshot.settings.aiModel) return null;
  const [datasource, inspected] = await Promise.all([
    getDatasource(),
    sendToFrame(tabId, snapshot.frameId, { type: 'JOB_APP_INSPECT' }),
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
  const settings=await getSettings(); const apiKey=await getApiKey(settings.aiProvider);
  if(!apiKey) return;
  const inspected=await sendToApplicationFrame(tabId,run,{type:'JOB_APP_INSPECT'});
  if(!inspected?.ok || pageSignature(inspected.inspection,run.frame)!==run.pageSignature) return;
  const validated=await sendToApplicationFrame(tabId,run,{type:'JOB_APP_VALIDATE'});
  const invalidIds=new Set((validated?.validation?.invalid || []).map(field=>field.fieldId));
  const datasource=await getDatasource();
  const fields=resolveEmploymentFields(run,inspected.inspection.fields,datasource.profile);
  const unresolved=fields.filter(field=>field.required && !String(field.currentValue || '').trim() && (!run.suggestions?.[field.id] || invalidIds.has(field.id)) && readableQuestion(field) && inferSensitivity(field.label,field.id)!=='legal' && !field.entityUnresolved);
  if(!unresolved.length) return;
  const planner=run.aiOperations?.planner;
  const retryableStates=new Set(['failed','interrupted']);
  const plannerFields=retry
    ? (retryableStates.has(planner?.status) ? unresolved : [])
    : unresolved;
  const suggestionFields=retry
    ? unresolved.filter(field=>retryableStates.has(run.aiOperations?.[`suggestion:${field.id}`]?.status) && !run.generatedSuggestions?.[field.id])
    : unresolved.filter(field=>!run.generatedSuggestions?.[field.id]);
  if(!plannerFields.length && !suggestionFields.length) return;
  const operationFields=plannerFields.length ? plannerFields : suggestionFields;
  const evidenceRevision=aiEvidenceRevision(run,inspected.inspection,datasource);
  const fingerprint=aiFingerprint(run,operationFields,settings,evidenceRevision);
  const op=planner;
  if(op?.cacheKey===fingerprint && ((!retry && ['completed','failed','interrupted'].includes(op.status)) || op.status==='pending')) return;
  const id=`${WORKER_ID}:${Date.now()}:${Math.random()}`;
  const operationKey=plannerFields.length ? 'planner' : 'suggestion_batch';
  const snapshot={startedAt:run.startedAt,pageSignature:run.pageSignature,frameId:run.frame.frameId,cacheKey:fingerprint,id,operationKey,evidenceRevision,jobContext:run.jobContext || {},settings};
  await mutateRun(tabId,current=>{
    if(current.startedAt!==snapshot.startedAt || current.pageSignature!==snapshot.pageSignature) return false;
    current.aiOperations ||= {};
    current.aiOperations[operationKey]={status:'pending',cacheKey:fingerprint,id,workerId:WORKER_ID};
    current.progress='preparing_suggestions'; current.llmError=null;
  });
  const job=prepareAi(tabId,snapshot,plannerFields,suggestionFields,fields,datasource,apiKey).catch(async error=>{
    await mutateRun(tabId,current=>{
      if(current.aiOperations?.[operationKey]?.id!==id) return false;
      current.aiOperations[operationKey].status='failed';current.aiOperations[operationKey].error=error.message;current.llmError=error.message;current.progress='ready';
    });
  }).finally(()=>{ if(backgroundJobs.get(tabId)===job) backgroundJobs.delete(tabId); });
  backgroundJobs.set(tabId,job);
}

async function currentAiDestination(tabId,snapshot,field=null) {
  const run=await getRun(tabId);
  if(!run || run.startedAt!==snapshot.startedAt || run.pageSignature!==snapshot.pageSignature || run.frame?.frameId!==snapshot.frameId || run.aiOperations?.[snapshot.operationKey]?.id!==snapshot.id || !SAVABLE_RUN_STATUSES.has(run.status)) return null;
  const settings=await getSettings();
  if(settings.aiProvider!==snapshot.settings.aiProvider || settings.aiModel!==snapshot.settings.aiModel) return null;
  const [datasource, inspected]=await Promise.all([getDatasource(),sendToFrame(tabId,snapshot.frameId,{type:'JOB_APP_INSPECT'})]);
  if(!inspected?.ok || pageSignature(inspected.inspection,run.frame)!==snapshot.pageSignature) return null;
  if(aiEvidenceRevision(run,inspected.inspection,datasource)!==snapshot.evidenceRevision) return null;
  if(field) {
    const live=inspected.inspection.fields.find(item=>item.id===field.id);
    if(!live || live.currentValue!==field.currentValue || live.handle!==field.handle || JSON.stringify(live.constraints)!==JSON.stringify(field.constraints)) return null;
  }
  return {run,inspection:inspected.inspection};
}

async function prepareAi(tabId,snapshot,plannerFields,suggestionFields,allFields,datasource,apiKey) {
  const {aiProvider:provider,aiModel:model}=snapshot.settings;
  const plannerRecords=selectPlannerEvidence(plannerFields,datasource.answerRecords,{limit:20});
  let decisions=[]; let plannerError='';
  if(plannerFields.length) {
    try { decisions=(await callAnswerPlanner({apiKey,fields:plannerFields,records:plannerRecords,page:snapshot.jobContext},{provider,model,allowPartial:true})).decisions; }
    catch(error) {plannerError=error.message;}
  }
  const proposed=new Set();
  for(const decision of decisions) {
    const field=plannerFields.find(item=>item.id===decision.fieldId);
    if(!field || decision.action!=='fill' || !(await currentAiDestination(tabId,snapshot,field))) continue;
    const keys=[...new Set(decision.evidenceKeys)]; const sources=keys.map(key=>plannerRecords.find(record=>record.key===key));
    if(sources.some(source=>!source)) continue;
    const candidate={sourceKey:keys[0],sourceKeys:keys,sourceAnswers:Object.fromEntries(sources.map(source=>[source.key,source.answer])),sourceQuestion:sources.map(source=>source.question).join(' + '),answer:decision.value,excerpt:String(decision.value).slice(0,400),provenance:'AI planner',kind:'planner',requiresApproval:true,reason:decision.reason,transformation:decision.transformation || null,confidence:decision.confidence,sensitivity:decision.sensitivity};
    await mutateRun(tabId,current=>{
      if(current.aiOperations?.[snapshot.operationKey]?.id!==snapshot.id || current.pageSignature!==snapshot.pageSignature) return false;
      current.suggestions ||= {};
      current.suggestions[field.id]={tabId,frameId:snapshot.frameId,applicationId:snapshot.startedAt,pageSignature:snapshot.pageSignature,field,candidates:[candidate]};
    });
    proposed.add(field.id);
  }
  const pageRecords=allFields.filter(field=>field.currentValue && readableQuestion(field)).map(field=>({key:`page:${field.id}`,question:field.label,answer:field.currentValue,provenance:'current application page',sensitivity:inferSensitivity(field.label,field.id),entityId:field.entityId,entityType:field.entityType}));
  const evidence=[...datasource.answerRecords,...profileEvidenceRecords(datasource.profile),...pageRecords];
  const tasks=suggestionFields.filter(field=>!proposed.has(field.id)).sort((a,b)=>Number(a.type==='textarea')-Number(b.type==='textarea'));
  let index=0;
  const consume=async()=>{while(index<tasks.length){
    const field=tasks[index++]; const key=`suggestion:${field.id}`;
    if(!(await currentAiDestination(tabId,snapshot,field))) continue;
    await mutateRun(tabId,current=>{if(current.aiOperations?.[snapshot.operationKey]?.id!==snapshot.id)return false;current.aiOperations[key]={status:'pending',workerId:WORKER_ID,id:snapshot.id,cacheKey:snapshot.cacheKey};});
    try {
      const generated=await callAnswerSuggestions({apiKey,field,page:snapshot.jobContext,records:rankSuggestionEvidence(field,evidence,{limit:40})},{provider,model});
      if(!(await currentAiDestination(tabId,snapshot,field))) {
        await mutateRun(tabId,current=>{if(current.aiOperations?.[key]?.id!==snapshot.id)return false;current.aiOperations[key].status='interrupted';}); continue;
      }
      await mutateRun(tabId,current=>{
        if(current.aiOperations?.[snapshot.operationKey]?.id!==snapshot.id || current.pageSignature!==snapshot.pageSignature)return false;
        current.generatedSuggestions ||= {};
        current.generatedSuggestions[field.id]={tabId,frameId:snapshot.frameId,applicationId:snapshot.startedAt,pageSignature:snapshot.pageSignature,field,...generated};
        current.aiOperations[key].status='completed';
      });
      await validatePageOnly(tabId);
    } catch(error) {await mutateRun(tabId,current=>{if(current.aiOperations?.[key]?.id!==snapshot.id)return false;current.aiOperations[key].status='failed';current.aiOperations[key].error=error.message;current.llmError=error.message;});}
  }};
  await Promise.all([consume(),consume()]);
  await mutateRun(tabId,current=>{
    if(current.aiOperations?.[snapshot.operationKey]?.id!==snapshot.id)return false;
    current.aiOperations[snapshot.operationKey].status=plannerError?'failed':'completed';
    if(plannerError){current.aiOperations[snapshot.operationKey].error=plannerError;current.llmError=plannerError;}
    current.progress='ready';
  });
  await validatePageOnly(tabId);
}
