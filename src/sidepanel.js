const byId = (id) => document.getElementById(id);
const elements = {
  apiKey: byId('openai-api-key'),
  recordCount: byId('record-count'),
  run: byId('run-form'),
  runState: byId('run-state'),
  runHint: byId('run-hint'),
  reviewCard: byId('review-card'),
  reviewList: byId('review-list'),
  auditList: byId('audit-list'),
  confirm: byId('confirm-submit'),
  status: byId('status'),
  statusDot: byId('status-dot'),
};

let activeTabId = null;
let currentRun = null;

function setStatus(message, state = 'ok') {
  elements.status.textContent = message;
  elements.statusDot.className = `status-dot${state === 'ok' ? '' : ` ${state}`}`;
}

function setBusy(busy) {
  elements.run.disabled = busy;
  if (busy) setStatus('Working on the current application…', 'busy');
}

function updateRecordCount(records = []) {
  elements.recordCount.textContent = `${records.length} answer${records.length === 1 ? '' : 's'}`;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active browser tab was found.');
  activeTabId = tab.id;
  return tab;
}

function itemRow(item, detail = '') {
  const row = document.createElement('div');
  row.className = 'result-item';
  const label = document.createElement('span');
  label.className = 'result-label';
  label.textContent = item.label || item.question || item.fieldId || 'Field';
  const value = document.createElement('span');
  value.className = 'result-detail';
  value.textContent = detail || item.value || item.reason || 'Review this field';
  row.append(label, value);
  return row;
}

function renderRun(run) {
  currentRun = run || null;
  if (!run) {
    elements.runState.textContent = 'Ready';
    elements.runState.className = 'pill neutral';
    elements.run.textContent = 'Fill application';
    elements.run.disabled = false;
    elements.confirm.disabled = true;
    elements.reviewCard.hidden = true;
    return;
  }

  const labels = {
    running: 'Filling…',
    waiting_user: 'Waiting for you',
    ready_to_submit: 'Ready to submit',
    submitted: 'Submitted',
  };
  elements.runState.textContent = labels[run.status] || run.status;
  elements.runState.className = `pill${run.status === 'ready_to_submit' ? '' : ' neutral'}`;
  elements.run.textContent = run.status === 'waiting_user' ? 'Continue' : run.status === 'submitted' ? 'Start another application' : 'Fill application';
  elements.run.disabled = run.status === 'running';
  elements.confirm.disabled = run.status !== 'ready_to_submit';

  const review = [...(run.unresolved || []), ...(run.reviewRequired || [])];
  elements.reviewList.replaceChildren();
  if (review.length) {
    for (const item of review) elements.reviewList.append(itemRow(item, item.required ? `${item.reason || 'Required'} · complete this field` : item.value || item.reason));
  } else {
    elements.reviewList.append(itemRow({ label: 'No unresolved fields' }, 'All currently supported fields are validated.'));
  }
  elements.auditList.replaceChildren();
  for (const item of run.audit || []) elements.auditList.append(itemRow(item, `${item.answer} · ${item.sensitivity}`));
  elements.reviewCard.hidden = !(review.length || (run.audit || []).length || run.status === 'ready_to_submit' || run.status === 'submitted');

  if (run.status === 'waiting_user') {
    const label = run.waitingLabel ? ` Focus: ${run.waitingLabel}.` : '';
    elements.runHint.textContent = `Complete the highlighted field or handle the manual step, then continue.${label}`;
    setStatus(run.llmError ? `Local fill continued; answer planner unavailable: ${run.llmError}` : 'Waiting for the page to be completed.', run.llmError ? 'error' : 'ok');
  } else if (run.status === 'ready_to_submit') {
    elements.runHint.textContent = 'Review the visible form and the attention list, then confirm once to submit.';
    setStatus('Review complete. Submission still requires your confirmation.');
  } else if (run.status === 'submitted') {
    elements.runHint.textContent = 'Answers from this confirmed application are now in the local profile.';
    setStatus('Application submitted and answers saved.');
  } else if (run.status === 'running') {
    setStatus(`Filling page ${run.pageNumber || 1}…`, 'busy');
  }
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id || null;
  const stored = await chrome.storage.local.get({ answerRecords: [], openaiApiKey: '' });
  elements.apiKey.value = stored.openaiApiKey || '';
  updateRecordCount(stored.answerRecords);
  if (activeTabId) {
    const response = await chrome.runtime.sendMessage({ type: 'JOB_RUN_STATE', tabId: activeTabId });
    if (response?.ok) renderRun(response.run);
  }
}

async function saveApiKey() {
  await chrome.storage.local.set({ openaiApiKey: elements.apiKey.value.trim() });
  setStatus(elements.apiKey.value.trim() ? 'API key saved in trusted extension storage.' : 'API key cleared. Local answers still work.');
}

async function runApplication() {
  setBusy(true);
  try {
    const tab = await activeTab();
    const response = await chrome.runtime.sendMessage({
      type: currentRun?.status === 'waiting_user' ? 'JOB_RUN_CONTINUE' : 'JOB_RUN_START',
      tabId: tab.id,
    });
    if (!response?.ok) throw new Error(response?.error || 'Could not start the application run.');
    renderRun(response.run);
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    if (currentRun?.status !== 'running') setBusy(false);
  }
}

async function confirmSubmit() {
  elements.confirm.disabled = true;
  setStatus('Rechecking the page and saving confirmed answers…', 'busy');
  try {
    const tab = await activeTab();
    const response = await chrome.runtime.sendMessage({ type: 'JOB_RUN_CONFIRM_SUBMIT', tabId: tab.id });
    if (!response?.ok) throw new Error(response?.error || 'Submission was not completed.');
    renderRun(response.run);
  } catch (error) {
    setStatus(error.message, 'error');
    elements.confirm.disabled = currentRun?.status !== 'ready_to_submit';
  }
}

elements.apiKey.addEventListener('change', saveApiKey);
elements.apiKey.addEventListener('blur', saveApiKey);
elements.run.addEventListener('click', runApplication);
elements.confirm.addEventListener('click', confirmSubmit);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.answerRecords) updateRecordCount(changes.answerRecords.newValue || []);
  if (area === 'session' && changes.applicationRun && activeTabId) renderRun(changes.applicationRun.newValue?.[String(activeTabId)] || null);
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  activeTabId = tabId;
  refresh().catch((error) => setStatus(error.message, 'error'));
});

refresh().catch((error) => setStatus(error.message, 'error'));
