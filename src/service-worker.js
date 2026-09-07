import { callAnswerPlanner } from './llm.js';
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
import { planDeterministicFill } from './form-engine.js';

const RUN_STORAGE_KEY = 'applicationRun';
const MAX_PAGES = 20;
const ACTIVE_RUN_STATUSES = new Set(['running', 'waiting_user', 'page_ready', 'ready_for_user_submit']);
const SAVABLE_RUN_STATUSES = new Set(['waiting_user', 'page_ready', 'ready_for_user_submit', 'answers_saved']);
const processingTabs = new Set();
const saveLocks = new Set();
let datasourceWriteChain = Promise.resolve();
let runWriteChain = Promise.resolve();
let datasourceInitPromise = null;

const APPLICATION_TITLE_PATTERN = /\b(?:apply|application|candidate|profile|resume|experience|education)\b/i;
const UTILITY_FRAME_PATTERN = /\b(?:search|cookie|job[\s-]?alerts?|talent[\s-]?communities?|subscribe|feedback)\b/i;
const NO_APPLICATION_FRAME_REASON = 'No unique application form frame was found. Complete the application manually.';
const AMBIGUOUS_APPLICATION_FRAME_REASON = 'More than one application form frame was found. Complete the application manually.';

async function getRuns() {
  const stored = await chrome.storage.session.get({ [RUN_STORAGE_KEY]: {} });
  return stored[RUN_STORAGE_KEY] || {};
}

async function getRun(tabId) {
  const runs = await getRuns();
  return runs[String(tabId)] || null;
}

async function saveRun(run) {
  runWriteChain = runWriteChain.catch(() => {}).then(async () => {
    const runs = await getRuns();
    runs[String(run.tabId)] = { ...run, updatedAt: new Date().toISOString() };
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
  });
  return state;
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

async function getCoverMessages() {
  return (await getDatasource()).coverMessages;
}

async function getSettings() {
  const stored = await chrome.storage.local.get({ autoAdvancePages: false, openaiModel: 'gpt-5.6-terra' });
  return {
    autoAdvancePages: Boolean(stored.autoAdvancePages),
    openaiModel: String(stored.openaiModel || 'gpt-5.6-terra').trim() || 'gpt-5.6-terra',
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
    initializedAt: state.datasourceMeta?.initializedAt || null,
    seededAt: state.datasourceMeta?.seededAt || null,
    learnedChanges,
    profile: state.profile,
  };
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

async function getApiKey() {
  const stored = await chrome.storage.local.get({ openaiApiKey: '' });
  return String(stored.openaiApiKey || '').trim();
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
    llmPages: [],
    llmError: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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

function unresolvedFields(fields, validation = {}) {
  const invalidIds = new Set((validation.invalid || []).map((field) => field.fieldId));
  return fields.filter((field) => !field.currentValue || invalidIds.has(field.id));
}

function reviewItems(fields, decisions, existing = [], appliedReviews = []) {
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
        value: field.currentValue,
        sensitivity: decision.sensitivity,
        confidence: decision.confidence,
        reason: decision.reason,
      });
    }
  }
  for (const item of appliedReviews) {
    const field = item.field || byId.get(item.fieldId);
    if (!field?.currentValue) continue;
    items.push({
      fieldId: field.id,
      label: field.label || field.id,
      value: field.currentValue,
      sensitivity: item.sensitivity,
      confidence: item.confidence,
      reason: item.reason,
    });
  }
  return [...new Map(items.map((item) => [item.fieldId, item])).values()];
}

function auditItems(records) {
  return records.map((record) => ({
    key: record.key,
    question: record.question,
    answer: record.answer,
    sensitivity: record.sensitivity,
  }));
}

function pageSnapshot(inspection, pageNumber, pageRecords) {
  return {
    pageNumber,
    page: inspection.page,
    values: pageRecords,
  };
}

async function recordPageCapture(run, inspection, pageRecords = [], { promote = false } = {}) {
  const saved = await persistLearnedRecords(pageRecords, run, { promote });
  run.answers = upsertAnswerRecords(run.answers, pageRecords);
  run.pages = [
    ...run.pages.filter((page) => page.pageNumber !== run.pageNumber),
    pageSnapshot(inspection, run.pageNumber, pageRecords),
  ].slice(-MAX_PAGES);
  run.audit = auditItems(run.answers);
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

function fieldIssue(field, invalidIds, unresolvedById = new Map()) {
  return {
    fieldId: field.id,
    label: field.label || field.id,
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
    .map((field) => fieldIssue(field, invalidIds, unresolvedById));
  run.actionRequired = [
    ...navigationIssues(inspection),
    ...unresolvedFieldsOnPage.filter((field) => field.required),
  ];
  run.optionalUnresolved = unresolvedFieldsOnPage.filter((field) => !field.required);
  run.audit = auditItems(run.answers);
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

async function applyPageDecisions(tabId, run, inspection, records, coverMessages, apiKey, model, profile = {}) {
  const currentPageSignature = pageSignature(inspection, run.frame);
  if (run.lastAction === 'next' && run.pageSignature === currentPageSignature) {
    run.status = 'waiting_user';
    run.waitingFor = 'navigation_not_detected';
    run.actionRequired = [{ reason: 'The page did not change after Next/Continue.' }];
    run.nextAction = null;
    return { run, inspection, validation: { ok: false, requiredEmpty: [], invalid: [] } };
  }

  run.lastAction = null;
  run.pageSignature = currentPageSignature;
  await saveRun(run);
  const employment = profile.employment?.[0];
  const scopedFields = employment
    ? inspection.fields.map((field) => field.entityType === 'employment' ? { ...field, employmentId: employment.id } : field)
    : inspection.fields;
  const localDecisions = planDeterministicFill(scopedFields, records, coverMessages, profile, inspection.page);
  const localResult = await sendToApplicationFrame(tabId, run, { type: 'JOB_APP_APPLY', decisions: localDecisions, applicationId: run.startedAt });
  if (!localResult?.ok) throw new Error(localResult?.error || 'The page rejected local answers');

  let refreshed = await sendToApplicationFrame(tabId, run, { type: 'JOB_APP_INSPECT' });
  let currentInspection = refreshed.inspection;
  let validationResponse = await sendToApplicationFrame(tabId, run, { type: 'JOB_APP_VALIDATE' });
  let currentValidation = validationResponse?.validation || {};
  let allDecisions = [...localDecisions];
  let appliedReviews = [...(localResult.result?.reviewRequired || [])];
  let unresolvedResults = [...(localResult.result?.unresolved || [])];
  let llmError = null;
  const remaining = unresolvedFields(currentInspection.fields, currentValidation);
  const llmPageKey = `${run.pageNumber}:${currentPageSignature}`;
  if (remaining.length && apiKey && !run.llmPages.includes(llmPageKey)) {
    run.llmPages = [...run.llmPages, llmPageKey];
    await saveRun(run);
    try {
      const llmDecisions = await callAnswerPlanner({
        apiKey,
        fields: remaining,
        records,
        page: currentInspection.page,
      }, { model, allowPartial: true });
      const llmResult = await sendToApplicationFrame(tabId, run, {
        type: 'JOB_APP_APPLY',
        decisions: llmDecisions.decisions.map((decision) => ({ ...decision, handle: remaining.find((field) => field.id === decision.fieldId)?.handle })),
      });
      if (!llmResult?.ok) throw new Error(llmResult?.error || 'The page rejected an answer planner value');
      allDecisions = [...allDecisions, ...llmDecisions.decisions];
      appliedReviews = [...appliedReviews, ...(llmResult.result?.reviewRequired || [])];
      unresolvedResults = [...unresolvedResults, ...(llmResult.result?.unresolved || [])];
    } catch (error) {
      llmError = error.message;
    }
  }

  refreshed = await sendToApplicationFrame(tabId, run, { type: 'JOB_APP_INSPECT' });
  currentInspection = refreshed.inspection;
  validationResponse = await sendToApplicationFrame(tabId, run, { type: 'JOB_APP_VALIDATE' });
  currentValidation = validationResponse?.validation || { ok: false, requiredEmpty: [], invalid: [] };
  run = await capturePage(tabId, run, currentInspection);
  run.reviewRequired = reviewItems(
    currentInspection.fields,
    allDecisions,
    run.reviewRequired,
    appliedReviews,
  );
  run.llmError = llmError;
  return {
    run: categorizeRun(run, currentInspection, currentValidation, unresolvedResults),
    inspection: currentInspection,
    validation: currentValidation,
  };
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
    run.llmPages = Array.isArray(run.llmPages) ? run.llmPages : [];
    if (run.pageNumber > MAX_PAGES) {
      run.status = 'waiting_user';
      run.waitingFor = 'page_limit_exceeded';
      run.actionRequired = [{ reason: 'The application exceeded the 20-page automatic limit.' }];
      run.nextAction = null;
      return saveRun(run);
    }

    const [records, apiKey, coverMessages, settings, datasource] = await Promise.all([
      getRecords(),
      getApiKey(),
      getCoverMessages(),
      getSettings(),
      getDatasource(),
    ]);
    const discovery = await discoverApplicationFrame(tabId);
    if (discovery.errorCode) return saveRun(pauseForFrame(run, discovery));
    updateSelectedFrame(run, discovery);
    const processed = await applyPageDecisions(
      tabId,
      run,
      discovery.inspection,
      records,
      coverMessages,
      apiKey,
      settings.openaiModel,
      datasource.profile,
    );
    run = processed.run;
    const inspection = processed.inspection;
    const validation = processed.validation;

    if (run.waitingFor === 'navigation_not_detected') return saveRun(run);
    if (hasBlockingIssues(run, validation)) {
      run.status = 'waiting_user';
      run.waitingFor = run.actionRequired[0]?.reason || 'invalid_field';
      run.waitingLabel = await focusFirstProblem(tabId, run, inspection, validation);
      run.nextAction = null;
      return saveRun(run);
    }

    const nextActions = inspection.actions.filter((action) => action.kind === 'next');
    const submitActions = inspection.actions.filter((action) => action.kind === 'submit');
    if (nextActions.length === 1) {
      if (run.pageNumber >= MAX_PAGES) {
        run.status = 'waiting_user';
        run.waitingFor = 'page_limit_exceeded';
        run.actionRequired = [{ reason: 'The application reached the 20-page automatic limit.' }];
        run.nextAction = null;
        return saveRun(run);
      }
      run.nextAction = nextActions[0];
      run.waitingFor = null;
      run.waitingLabel = null;
      if (!autoAdvance) {
        run.status = 'page_ready';
        return saveRun(run);
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
        return saveRun(run);
      }
      run.pageNumber += 1;
      run.status = 'running';
      run.lastAction = 'next';
      return saveRun(run);
    }
    if (submitActions.length === 1 && validation.ok) {
      run.status = 'ready_for_user_submit';
      run.nextAction = null;
      run.waitingFor = null;
      run.waitingLabel = null;
      return saveRun(run);
    }

    run.status = 'waiting_user';
    run.waitingFor = submitActions.length === 0 ? 'no_submit_control' : 'ambiguous_navigation';
    run.actionRequired = [{ reason: run.waitingFor }];
    run.nextAction = null;
    return saveRun(run);
  } catch (error) {
    if (error.frameDiscovery) {
      const currentRun = await getRun(tabId);
      if (!currentRun) return null;
      return saveRun(pauseForFrame(currentRun, error.frameDiscovery));
    }
    const run = await getRun(tabId);
    if (!run) return null;
    if (run.lastAction === 'next') {
      run.status = 'waiting_user';
      run.waitingFor = 'navigation_not_detected';
      run.actionRequired = [{ reason: 'The page could not be inspected after Next/Continue.' }];
      run.nextAction = null;
      return saveRun(run);
    }
    run.status = 'waiting_user';
    run.waitingFor = 'extension_error';
    run.actionRequired = [{ reason: error.message }];
    run.nextAction = null;
    return saveRun(run);
  } finally {
    processingTabs.delete(tabId);
  }
}

async function startRun(tabId) {
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

async function saveAnswers(tabId) {
  if (saveLocks.has(tabId)) return { ok: false, error: 'Answer saving is already in progress' };
  saveLocks.add(tabId);
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
    const result = await recordPageCapture(run, inspection, captured.records || [], { promote: true });
    run = result.run;
    if (run.status === 'ready_for_user_submit') {
      run.status = 'answers_saved';
      run.waitingFor = null;
      run.waitingLabel = null;
    }
    return { ok: true, run: await saveRun(run), ...result.stats };
  } catch (error) {
    if (!error.frameDiscovery) throw error;
    return { ok: false, error: error.message, run: await saveRun(pauseForFrame(run, error.frameDiscovery)) };
  } finally {
    saveLocks.delete(tabId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    'JOB_RUN_START',
    'JOB_RUN_CHECK_PAGE',
    'JOB_RUN_ADVANCE_PAGE',
    'JOB_RUN_FOCUS_FIELD',
    'JOB_RUN_SAVE_ANSWERS',
    'JOB_RUN_STATE',
    'JOB_DATASOURCE_STATE',
    'JOB_DATASOURCE_EXPORT',
    'JOB_DATASOURCE_IMPORT',
    'JOB_DATASOURCE_CORRECT',
    'JOB_DATASOURCE_PROFILE_UPDATE',
  ].includes(message?.type)) return false;

  (async () => {
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
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = message.tabId || tab?.id;
    if (!tabId) throw new Error('No active browser tab was found');
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
  if (changeInfo.status !== 'complete') return;
  getRun(tabId)
    .then(async (run) => {
      if (run?.status !== 'running') return;
      run.frame = null;
      await saveRun(run);
      const settings = await getSettings();
      await processPage(tabId, { autoAdvance: settings.autoAdvancePages });
    })
    .catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => removeRun(tabId).catch(() => {}));

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
