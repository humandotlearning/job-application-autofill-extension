import { callAnswerPlanner } from './llm.js';
import { normalizeAnswerRecord, upsertAnswerRecords } from './core.js';
import { planDeterministicFill } from './form-engine.js';

const RUN_STORAGE_KEY = 'applicationRun';
const MAX_PAGES = 20;
const processingTabs = new Set();
const submissionLocks = new Set();

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

async function getRecords() {
  const stored = await chrome.storage.local.get({ answerRecords: [] });
  const records = stored.answerRecords.map(normalizeAnswerRecord).filter((record) => record.key && record.answer);
  if (JSON.stringify(records) !== JSON.stringify(stored.answerRecords)) await chrome.storage.local.set({ answerRecords: records });
  return records;
}

async function getApiKey() {
  const stored = await chrome.storage.local.get({ openaiApiKey: '' });
  return String(stored.openaiApiKey || '').trim();
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['dist/content.js'] });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

function nowRun(tabId) {
  return {
    tabId,
    status: 'running',
    pageNumber: 1,
    pages: [],
    answers: [],
    reviewRequired: [],
    unresolved: [],
    audit: [],
    llmPages: [],
    llmError: null,
    submitted: false,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function fieldMap(fields) {
  return new Map(fields.map((field) => [field.id, field]));
}

function pageSignature(inspection) {
  return JSON.stringify({
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
    if (decision.sensitivity !== 'safe' || decision.confidence !== 'high' || field.type === 'textarea' || String(field.currentValue).length > 240) {
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
  for (const field of fields) {
    if (field.currentValue && field.type === 'textarea') {
      items.push({ fieldId: field.id, label: field.label || field.id, value: field.currentValue, sensitivity: 'safe', confidence: 'medium', reason: 'Long-form answer requires review' });
    }
  }
  for (const item of appliedReviews) {
    const field = item.field || byId.get(item.fieldId);
    if (field?.currentValue) items.push({
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

async function capturePage(tabId, run, inspection) {
  const response = await sendToTab(tabId, { type: 'JOB_APP_CAPTURE' });
  const pageRecords = response?.records || [];
  run.answers = upsertAnswerRecords(run.answers, pageRecords);
  run.pages = [...run.pages, { page: inspection.page, values: pageRecords }].slice(-MAX_PAGES);
  run.audit = auditItems(run.answers);
  return run;
}

function blockingProblems(inspection, validation) {
  const required = validation.requiredEmpty || [];
  const invalid = validation.invalid || [];
  return [...inspection.pauseReasons, ...required.map(() => 'missing_required'), ...invalid.map(() => 'invalid_field')];
}

async function focusFirstProblem(tabId, inspection, validation) {
  const first = validation.requiredEmpty[0] || validation.invalid[0];
  if (first) await sendToTab(tabId, { type: 'JOB_APP_FOCUS', fieldId: first.fieldId }).catch(() => {});
  return first?.label || inspection.fields.find((field) => !field.currentValue)?.label || '';
}

async function processPage(tabId) {
  if (processingTabs.has(tabId)) return getRun(tabId);
  processingTabs.add(tabId);
  try {
    let run = await getRun(tabId);
    if (!run || run.status !== 'running') return run;
    run.llmPages = Array.isArray(run.llmPages) ? run.llmPages : [];
    if (run.pageNumber > MAX_PAGES) {
      run.status = 'waiting_user';
      run.unresolved = [{ reason: 'The application exceeded the automatic page limit.' }];
      return saveRun(run);
    }

    const [records, apiKey] = await Promise.all([getRecords(), getApiKey()]);
    let inspected = await sendToTab(tabId, { type: 'JOB_APP_INSPECT' });
    if (!inspected?.ok) throw new Error(inspected?.error || 'The page could not be inspected');
    let inspection = inspected.inspection;
    const currentPageSignature = pageSignature(inspection);
    if (run.lastAction === 'next' && run.pageSignature === currentPageSignature) {
      run.status = 'waiting_user';
      run.waitingFor = 'navigation_not_detected';
      run.unresolved = [{ reason: 'The page did not change after Next/Continue.' }];
      return saveRun(run);
    }
    run.lastAction = null;
    run.pageSignature = currentPageSignature;
    const localDecisions = planDeterministicFill(inspection.fields, records);
    const localResult = await sendToTab(tabId, { type: 'JOB_APP_APPLY', decisions: localDecisions });
    if (!localResult?.ok) throw new Error(localResult?.error || 'The page rejected local answers');

    inspected = await sendToTab(tabId, { type: 'JOB_APP_INSPECT' });
    inspection = inspected.inspection;
    const localValidationResponse = await sendToTab(tabId, { type: 'JOB_APP_VALIDATE' });
    const localValidation = localValidationResponse?.validation || {};
    let allDecisions = [...localDecisions];
    let appliedReviews = [...(localResult.result?.reviewRequired || [])];
    let llmError = null;
    const remaining = unresolvedFields(inspection.fields, localValidation);
    const llmPageKey = `${run.pageNumber}:${currentPageSignature}`;
    if (remaining.length && apiKey && !run.llmPages.includes(llmPageKey)) {
      run.llmPages = [...run.llmPages, llmPageKey];
      await saveRun(run);
      try {
        const llmDecisions = await callAnswerPlanner({ apiKey, fields: remaining, records, page: inspection.page });
        const llmResult = await sendToTab(tabId, { type: 'JOB_APP_APPLY', decisions: llmDecisions.decisions });
        if (!llmResult?.ok) throw new Error(llmResult?.error || 'The page rejected an answer planner value');
        allDecisions = [...allDecisions, ...llmDecisions.decisions];
        appliedReviews = [...appliedReviews, ...(llmResult.result?.reviewRequired || [])];
      } catch (error) {
        llmError = error.message;
      }
    }

    inspected = await sendToTab(tabId, { type: 'JOB_APP_INSPECT' });
    inspection = inspected.inspection;
    const validationResponse = await sendToTab(tabId, { type: 'JOB_APP_VALIDATE' });
    const validation = validationResponse?.validation || { ok: false, requiredEmpty: [], invalid: [] };
    run = await capturePage(tabId, run, inspection);
    run.reviewRequired = reviewItems(inspection.fields, allDecisions, run.reviewRequired, appliedReviews);
    const invalidIds = new Set((validation.invalid || []).map((field) => field.fieldId));
    run.unresolved = inspection.fields
      .filter((field) => !field.currentValue || invalidIds.has(field.id))
      .map((field) => ({
        fieldId: field.id,
        label: field.label || field.id,
        required: field.required,
        reason: invalidIds.has(field.id) ? 'The current value does not satisfy the field constraints' : 'No validated answer is available',
      }));
    run.llmError = llmError;

    const problems = blockingProblems(inspection, validation);
    if (problems.length) {
      run.status = 'waiting_user';
      run.waitingFor = problems[0];
      run.waitingLabel = await focusFirstProblem(tabId, inspection, validation);
      return saveRun(run);
    }

    const nextActions = inspection.actions.filter((action) => action.kind === 'next');
    const submitActions = inspection.actions.filter((action) => action.kind === 'submit');
    if (nextActions.length === 1) {
      const clicked = await sendToTab(tabId, { type: 'JOB_APP_CLICK_NEXT', actionId: nextActions[0].id });
      if (!clicked?.ok) {
        run.status = 'waiting_user';
        run.waitingFor = 'ambiguous_navigation';
        run.unresolved.push({ reason: clicked?.error || 'The Next control could not be activated' });
        return saveRun(run);
      }
      run.pageNumber += 1;
      run.status = 'running';
      run.lastAction = 'next';
      run.waitingFor = null;
      return saveRun(run);
    }
    if (submitActions.length === 1 && validation.ok) {
      run.status = 'ready_to_submit';
      run.waitingFor = null;
      return saveRun(run);
    }

    run.status = 'waiting_user';
    run.waitingFor = submitActions.length === 0 ? 'no_submit_control' : 'ambiguous_navigation';
    return saveRun(run);
  } catch (error) {
    const run = await getRun(tabId);
    if (!run) return null;
    if (run.lastAction === 'next') {
      run.status = 'waiting_user';
      run.waitingFor = 'navigation_not_detected';
      run.unresolved = [{ reason: 'The page could not be inspected after Next/Continue.' }];
      return saveRun(run);
    }
    run.status = 'waiting_user';
    run.waitingFor = 'extension_error';
    run.unresolved = [{ reason: error.message }];
    return saveRun(run);
  } finally {
    processingTabs.delete(tabId);
  }
}

async function startRun(tabId) {
  const current = await getRun(tabId);
  if (current && (current.status === 'running' || current.status === 'ready_to_submit')) return current.status === 'running' ? processPage(tabId) : current;
  const run = await saveRun(nowRun(tabId));
  return processPage(tabId, run);
}

async function continueRun(tabId) {
  const run = await getRun(tabId);
  if (!run) return startRun(tabId);
  if (run.status === 'ready_to_submit' || run.status === 'submitted') return run;
  run.status = 'running';
  run.waitingFor = null;
  await saveRun(run);
  return processPage(tabId);
}

async function confirmSubmit(tabId) {
  if (submissionLocks.has(tabId)) return { ok: false, error: 'Submission is already in progress' };
  submissionLocks.add(tabId);
  try {
    const run = await getRun(tabId);
    if (!run || run.status !== 'ready_to_submit' || run.submitted) return { ok: false, error: 'The application is not ready for confirmation' };
    const inspectionResponse = await sendToTab(tabId, { type: 'JOB_APP_INSPECT' });
    const validationResponse = await sendToTab(tabId, { type: 'JOB_APP_VALIDATE' });
    const inspection = inspectionResponse?.inspection;
    const validation = validationResponse?.validation;
    if (!inspectionResponse?.ok || !validationResponse?.ok || inspection.pauseReasons.length || !validation?.ok) {
      run.status = 'waiting_user';
      run.waitingFor = inspection.pauseReasons[0] || 'invalid_field';
      await saveRun(run);
      return { ok: false, error: 'The page changed. Review the unresolved fields before submitting.', run };
    }
    const captured = await sendToTab(tabId, { type: 'JOB_APP_CAPTURE' });
    const existing = await getRecords();
    const answers = upsertAnswerRecords(existing, [...run.answers, ...(captured.records || [])]);
    await chrome.storage.local.set({ answerRecords: answers });
    const submitted = await sendToTab(tabId, { type: 'JOB_APP_SUBMIT' });
    if (!submitted?.ok) throw new Error(submitted?.error || 'The form did not submit');
    run.answers = answers;
    run.audit = auditItems(answers);
    run.status = 'submitted';
    run.submitted = true;
    run.submittedAt = new Date().toISOString();
    return { ok: true, run: await saveRun(run) };
  } catch (error) {
    const run = await getRun(tabId);
    if (run) {
      run.status = 'ready_to_submit';
      run.waitingFor = 'submission_error';
      run.llmError = error.message;
      await saveRun(run);
    }
    return { ok: false, error: error.message, run };
  } finally {
    submissionLocks.delete(tabId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'JOB_APP_NAVIGATED') {
    const tabId = sender?.tab?.id;
    (async () => {
      const run = tabId ? await getRun(tabId) : null;
      if (run?.status !== 'running' || run.lastAction !== 'next') return { ok: true, run };
      return { ok: true, run: await processPage(tabId) };
    })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (!['JOB_RUN_START', 'JOB_RUN_CONTINUE', 'JOB_RUN_CONFIRM_SUBMIT', 'JOB_RUN_STATE'].includes(message?.type)) return false;
  (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = message.tabId || tab?.id;
    if (!tabId) throw new Error('No active browser tab was found');
    if (message.type === 'JOB_RUN_STATE') return { ok: true, run: await getRun(tabId) };
    if (message.type === 'JOB_RUN_CONFIRM_SUBMIT') return confirmSubmit(tabId);
    const run = message.type === 'JOB_RUN_START' ? await startRun(tabId) : await continueRun(tabId);
    return { ok: true, run };
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  getRun(tabId).then((run) => run?.status === 'running' && processPage(tabId)).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => removeRun(tabId).catch(() => {}));

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await chrome.storage.session.clear();
  await chrome.storage.local.remove(['sheetUrl', 'answerSource', 'lastSyncedAt', 'pendingLearnedAnswers']);
  if (chrome.storage.local.setAccessLevel) await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
});
