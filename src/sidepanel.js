import { expandEmailTemplateRecords, parseCsv, rowsToRecords } from './core.js';
import { fetchGoogleSheetRecords, fetchPrivateGoogleSheetRecords } from './data-source.js';

const DEFAULT_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1SoKWd8RL1YpZxP3Bvs5bclF_fhs47VZpk1wh6H6UBJ0/edit?gid=0#gid=0';
const byId = (id) => document.getElementById(id);
const elements = {
  sheetUrl: byId('sheet-url'),
  syncSheet: byId('sync-sheet'),
  csvFile: byId('csv-file'),
  scanForm: byId('scan-form'),
  fillForm: byId('fill-form'),
  fillEmailTemplate: byId('fill-email-template'),
  startLearning: byId('start-learning'),
  approveLearned: byId('approve-learned'),
  learnResponses: byId('learn-responses'),
  pendingCount: byId('pending-count'),
  overwrite: byId('overwrite'),
  recordCount: byId('record-count'),
  pageState: byId('page-state'),
  summary: byId('summary'),
  resultsCard: byId('results-card'),
  results: byId('results'),
  status: byId('status'),
  statusDot: byId('status-dot'),
};

function setStatus(message, state = 'ok') {
  elements.status.textContent = message;
  elements.statusDot.className = `status-dot${state === 'ok' ? '' : ` ${state}`}`;
}

function setBusy(busy) {
  for (const button of [elements.syncSheet, elements.scanForm, elements.fillForm, elements.fillEmailTemplate, elements.startLearning, elements.approveLearned]) button.disabled = busy;
}

function updateRecordCount(records) {
  elements.recordCount.textContent = `${records.length} answer${records.length === 1 ? '' : 's'}`;
}

async function saveRecords(records, sheetUrl, source) {
  await chrome.storage.local.set({
    answerRecords: records,
    sheetUrl,
    answerSource: source,
    lastSyncedAt: new Date().toISOString(),
  });
  updateRecordCount(records);
}

async function saveFormSession(tabId, report) {
  const { formSessions = {} } = await chrome.storage.session.get({ formSessions: {} });
  formSessions[String(tabId)] = { report, savedAt: Date.now() };
  await chrome.storage.session.set({ formSessions });
}

function clearReport() {
  elements.summary.hidden = true;
  elements.resultsCard.hidden = true;
  elements.results.replaceChildren();
  elements.pageState.textContent = 'Not scanned';
  elements.pageState.className = 'pill neutral';
  for (const id of ['count-scanned', 'count-filled', 'count-review', 'count-unknown', 'count-errors']) byId(id).textContent = '0';
}

async function restoreFormSession(tabId) {
  const { formSessions = {} } = await chrome.storage.session.get({ formSessions: {} });
  const session = formSessions[String(tabId)];
  if (session?.report) renderReport(session.report);
  else clearReport();
}

async function getRecords() {
  const { answerRecords = [] } = await chrome.storage.local.get('answerRecords');
  const expanded = expandEmailTemplateRecords(answerRecords);
  if (expanded.length !== answerRecords.length) await chrome.storage.local.set({ answerRecords: expanded });
  return expanded;
}

async function getGoogleToken() {
  const clientId = chrome.runtime.getManifest().oauth2?.client_id || '';
  if (!clientId || clientId.startsWith('REPLACE_WITH_')) {
    throw new Error('Private-sheet sync needs a Google OAuth client ID. Follow README.md, update manifest.json, and reload the extension.');
  }
  const result = await chrome.identity.getAuthToken({ interactive: true });
  return typeof result === 'string' ? result : result?.token;
}

async function syncSheet() {
  setBusy(true);
  setStatus('Syncing the Google Sheet…', 'busy');
  try {
    const sheetUrl = elements.sheetUrl.value.trim();
    let records;
    let source = 'google-sheet';
    try {
      records = await fetchGoogleSheetRecords(sheetUrl);
    } catch {
      setStatus('The sheet is private. Requesting read-only Google access…', 'busy');
      records = await fetchPrivateGoogleSheetRecords(sheetUrl, getGoogleToken);
      source = 'google-sheet-oauth';
    }
    await saveRecords(records, sheetUrl, source);
    setStatus(`Synced ${records.length} reusable answers.`);
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function importCsv(file) {
  setBusy(true);
  setStatus(`Importing ${file.name}…`, 'busy');
  try {
    const records = rowsToRecords(parseCsv(await file.text()), `csv:${file.name}`);
    if (!records.length) throw new Error('The CSV contains no reusable answers.');
    await saveRecords(records, elements.sheetUrl.value.trim(), `csv:${file.name}`);
    setStatus(`Imported ${records.length} reusable answers from ${file.name}.`);
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    elements.csvFile.value = '';
    setBusy(false);
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active browser tab was found.');
  return tab;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'JOB_AUTOFILL_PING' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['dist/content.js'] });
  }
}

async function runFormAction(fill, includeEmailTemplates = false) {
  setBusy(true);
  setStatus(fill ? (includeEmailTemplates ? 'Filling the saved email template…' : 'Filling verified fields in one pass…') : 'Scanning the current form…', 'busy');
  try {
    const records = await getRecords();
    const tab = await activeTab();
    await ensureContentScript(tab.id);
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: fill ? 'JOB_AUTOFILL_FILL' : 'JOB_AUTOFILL_SCAN',
      records,
      overwrite: elements.overwrite.checked,
      includeEmailTemplates,
    });
    if (!response?.ok) throw new Error(response?.error || 'The form did not return a report.');
    renderReport(response.report);
    await saveFormSession(tab.id, response.report);
    const count = response.report.filled.length;
    setStatus(fill ? `Filled ${count} safe field${count === 1 ? '' : 's'}; review the page before continuing.` : 'Form scan complete.');
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    setBusy(false);
  }
}

function appendGroup(title, items, detail) {
  if (!items?.length) return;
  const group = document.createElement('div');
  group.className = 'result-group';
  const heading = document.createElement('h3');
  heading.textContent = `${title} · ${items.length}`;
  group.append(heading);
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'result-item';
    const label = document.createElement('span');
    label.className = 'result-label';
    label.textContent = item.label;
    const meta = document.createElement('span');
    meta.className = 'result-detail';
    meta.textContent = detail(item);
    row.append(label, meta);
    group.append(row);
  }
  elements.results.append(group);
}

function renderReport(report) {
  elements.summary.hidden = false;
  elements.resultsCard.hidden = false;
  elements.results.replaceChildren();
  byId('count-scanned').textContent = report.scanned.length;
  byId('count-filled').textContent = report.filled.length;
  byId('count-review').textContent = report.review.length;
  byId('count-unknown').textContent = report.unknown.length;
  byId('count-errors').textContent = report.requiredEmpty.length;
  elements.pageState.textContent = report.page?.title || 'Scanned';
  elements.pageState.className = 'pill neutral';

  appendGroup('Filled', report.filled, (item) => `${item.key} · ${item.answer}`);
  appendGroup('Already populated', report.unchanged, (item) => `${item.key} · left unchanged`);
  appendGroup('Needs review', report.review, (item) => `${item.key} · ${item.answer || 'No answer'}`);
  appendGroup('Unknown', report.unknown, (item) => `${item.required ? 'Required' : 'Optional'} · no reliable match`);
  appendGroup('Required and empty', report.requiredEmpty, (item) => item.type);
  appendGroup('Could not fill', report.failed, (item) => `${item.key} · option/value not accepted`);

  if (!elements.results.children.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No supported form fields were found on this page.';
    elements.results.append(empty);
  }
}

async function refreshLearningCount() {
  const { pendingLearnedAnswers = [] } = await chrome.storage.local.get('pendingLearnedAnswers');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const pending = pendingLearnedAnswers.filter((record) => record.tabId == null || record.tabId === tab?.id);
  elements.pendingCount.textContent = `${pending.length} pending`;
  elements.approveLearned.disabled = !pending.some((record) => record.sensitivity === 'safe');
}

async function startLearning() {
  setBusy(true);
  try {
    const tab = await activeTab();
    await ensureContentScript(tab.id);
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'JOB_AUTOFILL_START_LEARNING' });
    if (!response?.ok) throw new Error(response?.error || 'Could not start learning on this page.');
    elements.learnResponses.checked = true;
    setStatus(`Learning enabled for ${response.observed} current fields. Complete the missing answers, then review the pending queue.`);
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function approveSafeLearned() {
  setBusy(true);
  try {
    const tab = await activeTab();
    const response = await chrome.runtime.sendMessage({ type: 'JOB_AUTOFILL_APPROVE_SAFE_LEARNED', tabId: tab.id });
    if (!response?.ok) throw new Error(response?.error || 'Could not approve learned answers.');
    setStatus('Approved safe learned answers for future autofill. Sensitive answers remain review-gated.');
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    setBusy(false);
    await refreshLearningCount();
  }
}
async function hydrate() {
  const stored = await chrome.storage.local.get(['sheetUrl', 'answerRecords', 'lastSyncedAt']);
  elements.sheetUrl.value = stored.sheetUrl || DEFAULT_SHEET_URL;
  updateRecordCount(stored.answerRecords || []);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) await restoreFormSession(tab.id);
  if (stored.lastSyncedAt) setStatus(`Ready. Last synced ${new Date(stored.lastSyncedAt).toLocaleString()}.`);
}

elements.syncSheet.addEventListener('click', syncSheet);
elements.csvFile.addEventListener('change', () => {
  const [file] = elements.csvFile.files || [];
  if (file) importCsv(file);
});
elements.scanForm.addEventListener('click', () => runFormAction(false));
elements.fillForm.addEventListener('click', () => runFormAction(true));
elements.fillEmailTemplate.addEventListener('click', () => {
  if (window.confirm('Fill the saved email/cover-letter template into a matching field? Review it before continuing.')) {
    runFormAction(true, true);
  }
});
elements.startLearning.addEventListener('click', startLearning);
elements.approveLearned.addEventListener('click', approveSafeLearned);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.pendingLearnedAnswers) refreshLearningCount();
  if (area === 'session' && changes.formSessions) {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab?.id && restoreFormSession(tab.id));
  }
});
chrome.tabs.onActivated.addListener(({ tabId }) => restoreFormSession(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') restoreFormSession(tabId);
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'JOB_AUTOFILL_LEARNED_SAVED' && message.added > 0) {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id !== message.tabId) return;
      refreshLearningCount();
      setStatus(`Saved ${message.added} new answer${message.added === 1 ? '' : 's'} for review.`);
    });
  }
});

hydrate().then(refreshLearningCount).catch((error) => setStatus(error.message, 'error'));
