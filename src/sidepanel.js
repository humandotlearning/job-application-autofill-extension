import { parseCsv, rowsToRecords } from './core.js';
import { fetchGoogleSheetRecords, fetchPrivateGoogleSheetRecords } from './data-source.js';

const DEFAULT_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1SoKWd8RL1YpZxP3Bvs5bclF_fhs47VZpk1wh6H6UBJ0/edit?gid=0#gid=0';
const byId = (id) => document.getElementById(id);
const elements = {
  sheetUrl: byId('sheet-url'),
  syncSheet: byId('sync-sheet'),
  csvFile: byId('csv-file'),
  scanForm: byId('scan-form'),
  fillForm: byId('fill-form'),
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
  for (const button of [elements.syncSheet, elements.scanForm, elements.fillForm]) button.disabled = busy;
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

async function getRecords() {
  const { answerRecords = [] } = await chrome.storage.local.get('answerRecords');
  return answerRecords;
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
  if (!tab?.id || !/^https?:/i.test(tab.url || '')) {
    throw new Error('Open an HTTP or HTTPS job application page first.');
  }
  return tab;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'JOB_AUTOFILL_PING' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['dist/content.js'] });
  }
}

async function runFormAction(fill) {
  setBusy(true);
  setStatus(fill ? 'Filling verified fields in one pass…' : 'Scanning the current form…', 'busy');
  try {
    const records = await getRecords();
    if (!records.length) throw new Error('Sync the Google Sheet or import a CSV before scanning.');
    const tab = await activeTab();
    await ensureContentScript(tab.id);
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: fill ? 'JOB_AUTOFILL_FILL' : 'JOB_AUTOFILL_SCAN',
      records,
      overwrite: elements.overwrite.checked,
    });
    if (!response?.ok) throw new Error(response?.error || 'The form did not return a report.');
    renderReport(response.report);
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

async function hydrate() {
  const stored = await chrome.storage.local.get(['sheetUrl', 'answerRecords', 'lastSyncedAt']);
  elements.sheetUrl.value = stored.sheetUrl || DEFAULT_SHEET_URL;
  updateRecordCount(stored.answerRecords || []);
  if (stored.lastSyncedAt) setStatus(`Ready. Last synced ${new Date(stored.lastSyncedAt).toLocaleString()}.`);
}

elements.syncSheet.addEventListener('click', syncSheet);
elements.csvFile.addEventListener('change', () => {
  const [file] = elements.csvFile.files || [];
  if (file) importCsv(file);
});
elements.scanForm.addEventListener('click', () => runFormAction(false));
elements.fillForm.addEventListener('click', () => runFormAction(true));
hydrate().catch((error) => setStatus(error.message, 'error'));
