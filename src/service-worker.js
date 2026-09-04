import { callAnswerPlanner } from './llm.js';
import { upsertAnswerRecords } from './core.js';
import {
  createDatasourceState,
  mergeDatasource,
  parseDatasourceBackup,
  serializeDatasourceBackup,
  seedDatasource,
  shouldSeedDatasource,
} from './datasource.js';
import { planDeterministicFill } from './form-engine.js';

const RUN_STORAGE_KEY = 'applicationRun';
const MAX_PAGES = 20;
const ACTIVE_RUN_STATUSES = new Set(['running', 'waiting_user', 'page_ready', 'ready_for_user_submit']);
const processingTabs = new Set();
const saveLocks = new Set();
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
  const runs = await getRuns();
  runs[String(run.tabId)] = { ...run, updatedAt: new Date().toISOString() };
  await chrome.storage.session.set({ [RUN_STORAGE_KEY]: runs });
  return runs[String(run.tabId)];
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
  });
  const current = createDatasourceState(stored);
  if (shouldSeedDatasource(current)) {
    const seeded = seedDatasource(await loadSeedData());
    await chrome.storage.local.set({
      answerRecords: seeded.answerRecords,
      coverMessages: seeded.coverMessages,
      datasourceMeta: seeded.datasourceMeta,
    });
    return seeded;
  }
  await chrome.storage.local.set({
    answerRecords: current.answerRecords,
    coverMessages: current.coverMessages,
    datasourceMeta: current.datasourceMeta,
  });
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
  });
  return state;
}

async function getRecords() {
  return (await getDatasource()).answerRecords;
}

async function getCoverMessages() {
  return (await getDatasource()).coverMessages;
}

async function getSettings() {
  const stored = await chrome.storage.local.get({ autoAdvancePages: false });
  return { autoAdvancePages: Boolean(stored.autoAdvancePages) };
}

async function datasourceSummary() {
  const state = await getDatasource();
  return {
    schemaVersion: state.schemaVersion,
    answerCount: state.answerRecords.length,
    coverMessageCount: state.coverMessages.length,
    initializedAt: state.datasourceMeta?.initializedAt || null,
    seededAt: state.datasourceMeta?.seededAt || null,
  };
}

async function importDatasourceBackup(backup) {
  const imported = parseDatasourceBackup(backup);
  const merged = mergeDatasource(await getDatasource(), imported);
  await saveDatasource(merged);
  return merged;
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
  const text = frameInspectionText(context, inspection);
  const applicationHint = APPLICATION_TITLE_PATTERN.test(text);
  const utilityHint = UTILITY_FRAME_PATTERN.test(text);
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

async function capturePage(tabId, run, inspection) {
  const response = await sendToApplicationFrame(tabId, run, { type: 'JOB_APP_CAPTURE' });
  const pageRecords = response?.records || [];
  run.answers = upsertAnswerRecords(run.answers, pageRecords);
  run.pages = [
    ...run.pages.filter((page) => page.pageNumber !== run.pageNumber),
    pageSnapshot(inspection, run.pageNumber, pageRecords),
  ].slice(-MAX_PAGES);
  run.audit = auditItems(run.answers);
  return run;
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

async function applyPageDecisions(tabId, run, inspection, records, coverMessages, apiKey) {
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
  const localDecisions = planDeterministicFill(inspection.fields, records, coverMessages);
  const localResult = await sendToApplicationFrame(tabId, run, { type: 'JOB_APP_APPLY', decisions: localDecisions });
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
      });
      const llmResult = await sendToApplicationFrame(tabId, run, {
        type: 'JOB_APP_APPLY',
        decisions: llmDecisions.decisions,
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

    const [records, apiKey, coverMessages] = await Promise.all([
      getRecords(),
      getApiKey(),
      getCoverMessages(),
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
    if (!run || (run.status !== 'ready_for_user_submit' && run.status !== 'answers_saved')) {
      return { ok: false, error: 'The current page is not ready to save answers' };
    }
    if (run.status === 'answers_saved') return { ok: true, run };
    const discovery = await discoverApplicationFrame(tabId);
    if (discovery.errorCode) return { ok: false, error: discovery.reason, run: await saveRun(pauseForFrame(run, discovery)) };
    updateSelectedFrame(run, discovery);
    const inspection = discovery.inspection;
    const validationResponse = await sendToApplicationFrame(tabId, run, { type: 'JOB_APP_VALIDATE' });
    const validation = validationResponse?.validation || { ok: false, requiredEmpty: [], invalid: [] };
    if (inspection.pauseReasons?.length || !validation.ok) {
      const updated = categorizeRun(run, inspection, validation);
      updated.status = 'waiting_user';
      updated.waitingFor = inspection.pauseReasons?.[0]
        || validation.requiredEmpty?.[0]?.fieldId
        || validation.invalid?.[0]?.fieldId
        || 'invalid_field';
      updated.waitingLabel = await focusFirstProblem(tabId, run, inspection, validation);
      return { ok: false, error: 'The page changed. Review the required fields before saving answers.', run: await saveRun(updated) };
    }
    const captured = await sendToApplicationFrame(tabId, run, { type: 'JOB_APP_CAPTURE' });
    const existing = await getRecords();
    const answers = upsertAnswerRecords(existing, [...run.answers, ...(captured.records || [])]);
    await chrome.storage.local.set({ answerRecords: answers });
    run.answers = upsertAnswerRecords(run.answers, captured.records || []);
    run.audit = auditItems(run.answers);
    run.status = 'answers_saved';
    run.waitingFor = null;
    run.waitingLabel = null;
    return { ok: true, run: await saveRun(run) };
  } catch (error) {
    if (!error.frameDiscovery) throw error;
    return { ok: false, error: error.message, run: await saveRun(pauseForFrame(run, error.frameDiscovery)) };
  } finally {
    saveLocks.delete(tabId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
        },
      };
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
  await chrome.storage.local.remove([
    'sheetUrl',
    'answerSource',
    'lastSyncedAt',
    'pendingLearnedAnswers',
  ]);
  if (chrome.storage.local.setAccessLevel) {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  }
});
