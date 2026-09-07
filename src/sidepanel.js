const byId = (id) => document.getElementById(id);
const elements = {
  apiKey: byId('openai-api-key'),
  apiModel: byId('openai-model'),
  autoAdvance: byId('auto-advance-pages'),
  employerName: byId('employer-name'),
  relatedDefault: byId('related-default'),
  knownDefault: byId('known-default'),
  recordCount: byId('record-count'),
  coverMessageCount: byId('cover-message-count'),
  datasourceHint: byId('datasource-hint'),
  learnedChangeCount: byId('learned-change-count'),
  learnedChangeList: byId('learned-change-list'),
  exportDatasource: byId('export-datasource'),
  importDatasourceButton: byId('import-datasource-button'),
  importDatasource: byId('import-datasource'),
  primaryAction: byId('primary-action'),
  secondaryActions: byId('secondary-actions'),
  checkPage: byId('check-page'),
  advancePage: byId('advance-page'),
  saveAnswers: byId('save-answers'),
  saveFeedback: byId('save-feedback'),
  runState: byId('run-state'),
  runHint: byId('run-hint'),
  actionRequiredCard: byId('action-required-card'),
  actionRequiredCount: byId('action-required-count'),
  actionRequiredList: byId('action-required-list'),
  reviewCard: byId('review-card'),
  reviewCount: byId('review-count'),
  reviewList: byId('review-list'),
  submitInstructions: byId('submit-instructions'),
  optionalDetails: byId('optional-details'),
  optionalCount: byId('optional-count'),
  optionalList: byId('optional-list'),
  auditDetails: byId('audit-details'),
  auditCount: byId('audit-count'),
  auditList: byId('audit-list'),
  status: byId('status'),
  statusDot: byId('status-dot'),
};

const STATUS_LABELS = {
  running: 'Filling…',
  waiting_user: 'Action required',
  page_ready: 'Page ready',
  ready_for_user_submit: 'Ready to save',
  answers_saved: 'Answers saved',
};

let activeTabId = null;
let currentRun = null;
let busy = false;
let saving = false;
const correctionDrafts = new Map();

function setSaveFeedback(message = '', state = '') {
  elements.saveFeedback.textContent = message;
  elements.saveFeedback.dataset.state = state;
  elements.saveFeedback.hidden = !message;
}

function setStatus(message, state = 'ok') {
  elements.status.textContent = message;
  elements.statusDot.className = `status-dot${state === 'ok' ? '' : ` ${state}`}`;
}

function updateDatasourceSummary(datasource = {}) {
  const answerCount = Number(datasource.answerCount || 0);
  const coverMessageCount = Number(datasource.coverMessageCount || 0);
  elements.recordCount.textContent = `${answerCount} answer${answerCount === 1 ? '' : 's'}`;
  elements.coverMessageCount.textContent = `${coverMessageCount} cover message${coverMessageCount === 1 ? '' : 's'}`;
  if (datasource.learnedChanges) renderLearnedChanges(datasource.learnedChanges);
  if (datasource.profile) {
    elements.employerName.value = datasource.profile.employment?.[0]?.company || 'DeepSight AI Labs';
    elements.relatedDefault.value = datasource.profile.defaults?.relatedToHiringCompany || 'No';
    elements.knownDefault.value = datasource.profile.defaults?.knownAtHiringCompany || 'No';
  }
}

function renderLearnedChanges(records) {
  elements.learnedChangeCount.textContent = String(records.length);
  elements.learnedChangeList.replaceChildren();
  for (const record of records) {
    const row = itemRow(record);
    const previous = document.createElement('p');
    previous.className = 'change-history';
    const values = [...new Set([...(record.history || []).map((item) => item.answer), ...(record.alternatives || [])])];
    previous.textContent = `${record.confirmationState === 'pending' ? 'Needs confirmation. ' : 'Saved locally. '}${record.context || ''}${values.length ? ` Previous or alternate values: ${values.join('; ')}` : ''}`;
    const correction = document.createElement('div');
    correction.className = 'correction-row';
    const input = document.createElement('input');
    input.value = correctionDrafts.has(record.key) ? correctionDrafts.get(record.key) : record.pendingAnswer || record.answer;
    input.addEventListener('input', () => correctionDrafts.set(record.key, input.value));
    input.setAttribute('aria-label', `Correct ${record.question}`);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Confirm value';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const submitted = input.value;
        const response = await chrome.runtime.sendMessage({ type: 'JOB_DATASOURCE_CORRECT', key: record.key, answer: submitted });
        if (!response?.ok) throw new Error(response?.error || 'Could not save the correction.');
        if (correctionDrafts.get(record.key) === submitted) correctionDrafts.delete(record.key);
        if (response.datasource) updateDatasourceSummary(response.datasource);
        setStatus('Correction saved. Previous values remain in history.');
      } catch (error) { setStatus(error.message, 'error'); }
      finally { button.disabled = false; }
    });
    correction.append(input, button);
    row.append(previous, correction);
    elements.learnedChangeList.append(row);
  }
  if (!records.length) elements.learnedChangeList.append(itemRow({ label: 'No learned changes yet' }, { detail: 'Changes and conflicting answers will appear here.' }));
}

function truncateAnswer(answer, limit = 180) {
  const text = String(answer ?? '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}…`;
}

function isOpaqueAnswer(answer) {
  return /^[a-f\d]{24,}$/i.test(String(answer ?? '').trim());
}

function answerNode(answer) {
  const text = String(answer ?? '');
  if (text.length <= 180) {
    const span = document.createElement('span');
    span.textContent = text;
    return span;
  }
  const details = document.createElement('details');
  details.className = 'answer-details';
  const summary = document.createElement('summary');
  summary.textContent = `${truncateAnswer(text)} (show full)`;
  const full = document.createElement('div');
  full.className = 'answer-full';
  full.textContent = text;
  details.append(summary, full);
  return details;
}

function itemRow(item, { focus = false, detail = '' } = {}) {
  const row = document.createElement('div');
  row.className = 'result-item';
  const content = document.createElement('div');
  const hasOpaqueSuggestion = Boolean(item.suggestion?.candidates?.some((candidate) => isOpaqueAnswer(candidate.answer)));
  const label = document.createElement('span');
  label.className = 'result-label';
  label.textContent = item.label || item.question || item.fieldId || 'Field';
  const value = document.createElement('span');
  value.className = 'result-detail';
  if (detail) value.textContent = detail;
  else if (hasOpaqueSuggestion) value.textContent = `Choose a value for ${label.textContent} on the application page, then click Check again.`;
  else if (item.value || item.answer) value.append(answerNode(item.value ?? item.answer));
  else value.textContent = item.reason || 'Review this field';
  content.append(label, value);
  row.append(content);
  if (item.suggestion) {
    const origin = item.suggestion;
    for (const candidate of origin.candidates) {
      if (isOpaqueAnswer(candidate.answer)) continue;
      const evidence = document.createElement('div');
      evidence.className = 'saved-evidence';
      const source = document.createElement('p');
      source.textContent = `${candidate.sourceQuestion} — ${candidate.provenance}.${candidate.reason ? ` ${candidate.reason}` : ''}`;
      const editor = document.createElement('textarea');
      editor.value = candidate.answer;
      editor.hidden = true;
      editor.setAttribute('aria-label', `Edit saved answer for ${item.label}`);
      const use = document.createElement('button');
      use.type = 'button'; use.textContent = 'Use this saved answer';
      const edit = document.createElement('button');
      edit.type = 'button'; edit.textContent = 'Edit and use';
      const approve = async (answer) => {
        use.disabled = edit.disabled = true;
        try {
          const response = await chrome.runtime.sendMessage({ type: 'JOB_RUN_APPROVE_SUGGESTION', tabId: origin.tabId, frameId: origin.frameId,
            applicationId: origin.applicationId, pageSignature: origin.pageSignature, fieldId: origin.field.id, handle: origin.field.handle, sourceKey: candidate.sourceKey, ...(answer != null ? { answer } : {}) });
          if (!response?.ok) throw new Error(response?.error || 'Could not use the saved answer');
          if (activeTabId === origin.tabId && response.run) renderRun(response.run);
          setStatus('Approved answer applied and verified. Submission remains manual.');
        } catch (error) { setStatus(error.message, 'error'); }
        finally { use.disabled = edit.disabled = false; }
      };
      use.addEventListener('click', () => approve());
      edit.addEventListener('click', () => {
        if (editor.hidden) { editor.hidden = false; edit.textContent = 'Approve edited answer'; editor.focus(); }
        else approve(editor.value);
      });
      evidence.append(source, answerNode(candidate.answer), editor, use, edit);
      content.append(evidence);
    }
  }
  if (focus && item.fieldId) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'inline-action';
    button.dataset.fieldId = item.fieldId;
    button.textContent = 'Show on page';
    row.append(button);
  }
  return row;
}

function renderList(container, items, options = {}) {
  container.replaceChildren();
  if (!items.length) {
    container.append(itemRow({ label: options.emptyLabel || 'None' }, { detail: options.emptyDetail || 'Nothing to review.' }));
    return;
  }
  for (const item of items) container.append(itemRow(item, options));
}

function setActionVisibility(run) {
  const status = run?.status;
  const hasRun = Boolean(run);
  elements.primaryAction.disabled = busy || status === 'running';
  for (const button of [elements.checkPage, elements.advancePage, elements.saveAnswers]) {
    button.disabled = busy || status === 'running';
  }
  elements.primaryAction.hidden = false;
  elements.checkPage.hidden = status !== 'page_ready';
  // The primary action carries the state-specific Continue/Save copy. Keep the
  // secondary row focused on the safe, repeatable “Check again” action.
  elements.advancePage.hidden = true;
  elements.saveAnswers.hidden = !['waiting_user', 'page_ready'].includes(status);
  elements.saveAnswers.textContent = saving ? 'Saving…' : 'Save filled values';
  elements.saveAnswers.setAttribute('aria-busy', String(saving));
  elements.secondaryActions.hidden = !hasRun || (elements.checkPage.hidden && elements.advancePage.hidden && elements.saveAnswers.hidden);
  if (!hasRun) {
    elements.primaryAction.textContent = 'Fill this page';
    return;
  }
  if (status === 'running') elements.primaryAction.textContent = 'Filling this page…';
  else if (status === 'waiting_user') elements.primaryAction.textContent = 'Check again';
  else if (status === 'page_ready') elements.primaryAction.textContent = 'Continue to next page';
  else if (status === 'ready_for_user_submit') elements.primaryAction.textContent = saving ? 'Saving…' : 'Save answers';
  else if (status === 'answers_saved') elements.primaryAction.textContent = 'Start another application';
  else elements.primaryAction.textContent = 'Fill this page';
}

function renderRun(run) {
  if (currentRun?.startedAt !== run?.startedAt || currentRun?.pageNumber !== run?.pageNumber || currentRun?.frame?.pathname !== run?.frame?.pathname || !run) {
    setSaveFeedback();
  }
  currentRun = run || null;
  if (!run) {
    elements.runState.textContent = 'Ready';
    elements.runState.className = 'pill neutral';
    elements.runHint.textContent = 'Fill one page at a time. Uploads, CAPTCHA, login, and final site submission stay manual.';
    elements.actionRequiredCard.hidden = true;
    elements.reviewCard.hidden = true;
    elements.optionalCount.textContent = '0';
    elements.auditCount.textContent = '0';
    renderList(elements.optionalList, [], { emptyLabel: 'No optional fields', emptyDetail: 'Optional questions will appear here when unanswered.' });
    renderList(elements.auditList, [], { emptyLabel: 'No captured values', emptyDetail: 'Filled values will appear here after a page check.' });
    setActionVisibility(null);
    return;
  }

  const rawActionRequired = run.actionRequired || run.unresolved || [];
  const actionRequired = rawActionRequired.some((item) => item.fieldId)
    ? rawActionRequired.filter((item) => item.fieldId || item.code !== 'unsupported_widget')
    : rawActionRequired;
  const optionalUnresolved = run.optionalUnresolved || [];
  const reviewRequired = run.reviewRequired || [];
  const audit = run.audit || [];
  elements.runState.textContent = STATUS_LABELS[run.status] || run.status;
  elements.runState.className = `pill${['page_ready', 'ready_for_user_submit', 'answers_saved'].includes(run.status) ? '' : ' neutral'}`;
  setActionVisibility(run);

  elements.actionRequiredCount.textContent = String(actionRequired.length);
  elements.actionRequiredCard.hidden = actionRequired.length === 0;
  renderList(elements.actionRequiredList, actionRequired, { focus: true, emptyDetail: 'No blockers on this page.' });

  elements.reviewCount.textContent = String(reviewRequired.length);
  elements.reviewCard.hidden = reviewRequired.length === 0 && !['ready_for_user_submit', 'answers_saved'].includes(run.status);
  renderList(elements.reviewList, reviewRequired, { emptyLabel: 'No additional review items', emptyDetail: 'All currently filled values are low-risk and validated.' });
  elements.submitInstructions.hidden = !['ready_for_user_submit', 'answers_saved'].includes(run.status);

  elements.optionalCount.textContent = String(optionalUnresolved.length);
  renderList(elements.optionalList, optionalUnresolved, { focus: true, emptyLabel: 'No optional unanswered fields', emptyDetail: 'Optional questions are complete or not present on this page.' });

  elements.auditCount.textContent = String(audit.length);
  renderList(elements.auditList, audit, { detail: '' });

  if (run.status === 'waiting_user') {
    const label = run.waitingLabel ? ` Focus: ${run.waitingLabel}.` : '';
    elements.runHint.textContent = `Complete the highlighted field or handle the manual step, then check again.${label}`;
    setStatus(run.llmError ? `Answer planner unavailable: ${run.llmError}` : 'Action is required on the application page.', run.llmError ? 'error' : 'ok');
  } else if (run.status === 'page_ready') {
    elements.runHint.textContent = 'This page is filled and validated. Review it, then continue when you are ready.';
    setStatus(`Page ${run.pageNumber || 1} is ready for your approval.`);
  } else if (run.status === 'ready_for_user_submit') {
    elements.runHint.textContent = 'Review the application and the lists below, then save the captured answers here. This never submits the site form.';
    setStatus('Final page is ready. Saving answers will not submit the application.');
  } else if (run.status === 'answers_saved') {
    elements.runHint.textContent = 'Answers are saved locally. Review the application and click Submit on the application site when ready.';
    setStatus('Answers saved. Submission remains manual.');
  } else if (run.status === 'running') {
    elements.runHint.textContent = `Filling page ${run.pageNumber || 1}. The panel will stop for your review before navigation.`;
    setStatus(`Filling page ${run.pageNumber || 1}…`, 'busy');
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active browser tab was found.');
  activeTabId = tab.id;
  return tab;
}

async function sendRunAction(type) {
  if (busy) return;
  busy = true;
  saving = type === 'JOB_RUN_SAVE_ANSWERS';
  const actionTabId = activeTabId;
  setSaveFeedback(saving ? 'Saving filled values…' : '', saving ? 'saving' : '');
  setActionVisibility(currentRun);
  setStatus(saving ? 'Saving filled values…' : 'Working on the current application…', 'busy');
  try {
    const tab = await activeTab();
    const response = await chrome.runtime.sendMessage({ type, tabId: tab.id });
    if (tab.id !== activeTabId) return;
    if (!response?.ok) throw new Error(response?.error || 'The application action could not be completed.');
    renderRun(response.run);
    if (type === 'JOB_RUN_SAVE_ANSWERS') {
      const legacyResponse = !['persisted', 'updated', 'unchanged', 'unresolved'].some((key) => Object.hasOwn(response, key));
      if (legacyResponse) {
        const count = response.savedCount || 0;
        const message = count > 0
          ? `Saved ${count} filled value${count === 1 ? '' : 's'} locally.`
          : 'No filled values found on this page; nothing was saved.';
        setSaveFeedback(message, count > 0 ? 'success' : 'empty');
        setStatus(message);
        return;
      }
      const parts = [];
      if (response.persisted) parts.push(`${response.persisted} new reusable`);
      if (response.updated) parts.push(`${response.updated} updated`);
      if (response.unchanged) parts.push(`${response.unchanged} unchanged`);
      if (response.unresolved) parts.push(`${response.unresolved} need attention`);
      const message = parts.length ? `Saved: ${parts.join(', ')}.` : 'No reusable values changed; current values remain in this application draft.';
      setSaveFeedback(message, response.savedCount > 0 ? 'success' : 'empty');
      setStatus(message);
    }
  } catch (error) {
    if (actionTabId !== activeTabId) return;
    if (saving) setSaveFeedback(`Could not save filled values. ${error.message} Try again.`, 'error');
    setStatus(error.message, 'error');
  } finally {
    busy = false;
    saving = false;
    setActionVisibility(currentRun);
  }
}

async function runPrimaryAction() {
  const type = !currentRun || currentRun.status === 'answers_saved'
    ? 'JOB_RUN_START'
    : currentRun.status === 'waiting_user'
      ? 'JOB_RUN_CHECK_PAGE'
      : currentRun.status === 'page_ready'
        ? 'JOB_RUN_ADVANCE_PAGE'
        : currentRun.status === 'ready_for_user_submit'
          ? 'JOB_RUN_SAVE_ANSWERS'
          : 'JOB_RUN_START';
  await sendRunAction(type);
}

async function focusField(fieldId) {
  try {
    const tab = await activeTab();
    const response = await chrome.runtime.sendMessage({ type: 'JOB_RUN_FOCUS_FIELD', tabId: tab.id, fieldId });
    if (!response?.ok) throw new Error(response?.error || 'Could not show this field on the page.');
    if (response.run) renderRun(response.run);
    setStatus('Showing the matching field on the application page.');
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id || null;
  const stored = await chrome.storage.local.get({ answerRecords: [], openaiApiKey: '', openaiModel: 'gpt-5.6-terra', autoAdvancePages: false });
  elements.apiKey.value = stored.openaiApiKey || '';
  elements.apiModel.value = stored.openaiModel || 'gpt-5.6-terra';
  elements.autoAdvance.checked = Boolean(stored.autoAdvancePages);
  updateDatasourceSummary({ answerCount: stored.answerRecords.length });
  const datasourceResponse = await chrome.runtime.sendMessage({ type: 'JOB_DATASOURCE_STATE' });
  if (datasourceResponse?.ok) updateDatasourceSummary(datasourceResponse.datasource);
  if (activeTabId) {
    const response = await chrome.runtime.sendMessage({ type: 'JOB_RUN_STATE', tabId: activeTabId });
    if (response?.ok) renderRun(response.run);
  } else renderRun(null);
}

async function exportDatasource() {
  elements.exportDatasource.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'JOB_DATASOURCE_EXPORT' });
    if (!response?.ok) throw new Error(response?.error || 'Could not export the datasource.');
    const blob = new Blob([JSON.stringify(response.backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `job-application-datasource-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setStatus('Datasource backup exported.');
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    elements.exportDatasource.disabled = false;
  }
}

async function importDatasource(file) {
  if (!file) return;
  elements.importDatasourceButton.disabled = true;
  try {
    const backup = JSON.parse(await file.text());
    const response = await chrome.runtime.sendMessage({ type: 'JOB_DATASOURCE_IMPORT', backup });
    if (!response?.ok) throw new Error(response?.error || 'Could not import the datasource backup.');
    updateDatasourceSummary(response.datasource);
    setStatus(`Datasource backup merged: ${response.datasource.answerCount} answers, ${response.datasource.coverMessageCount} cover messages.`);
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    elements.importDatasourceButton.disabled = false;
    elements.importDatasource.value = '';
  }
}

async function saveApiKey() {
  await chrome.storage.local.set({ openaiApiKey: elements.apiKey.value.trim() });
  setStatus(elements.apiKey.value.trim() ? 'API key saved in trusted extension storage.' : 'API key cleared. Local answers still work.');
}

async function saveModel() {
  const model = elements.apiModel.value.trim() || 'gpt-5.6-terra';
  elements.apiModel.value = model;
  await chrome.storage.local.set({ openaiModel: model });
  setStatus(`Answer planner model saved: ${model}.`);
}

async function saveSettings() {
  await chrome.storage.local.set({ autoAdvancePages: Boolean(elements.autoAdvance.checked) });
  setStatus(elements.autoAdvance.checked ? 'Automatic page advance enabled.' : 'Automatic page advance disabled.');
}

async function saveProfile() {
  try {
    const company = elements.employerName.value.trim() || 'DeepSight AI Labs';
    elements.employerName.value = company;
    const response = await chrome.runtime.sendMessage({ type: 'JOB_DATASOURCE_PROFILE_UPDATE', profile: {
      employment: [{ company }],
      defaults: { relatedToHiringCompany: elements.relatedDefault.value, knownAtHiringCompany: elements.knownDefault.value },
    } });
    if (!response?.ok) throw new Error(response?.error || 'Could not save profile defaults.');
    updateDatasourceSummary(response.datasource);
    setStatus('Profile defaults saved. They will be used on identified company questions.');
  } catch (error) { setStatus(error.message, 'error'); }
}

elements.apiKey.addEventListener('change', saveApiKey);
elements.apiKey.addEventListener('blur', saveApiKey);
elements.apiKey.addEventListener('input', saveApiKey);
elements.apiModel.addEventListener('change', saveModel);
elements.apiModel.addEventListener('blur', saveModel);
elements.autoAdvance.addEventListener('change', saveSettings);
for (const field of [elements.employerName, elements.relatedDefault, elements.knownDefault]) field.addEventListener('change', saveProfile);
elements.exportDatasource.addEventListener('click', exportDatasource);
elements.importDatasourceButton.addEventListener('click', () => elements.importDatasource.click());
elements.importDatasource.addEventListener('change', () => importDatasource(elements.importDatasource.files?.[0]));
elements.primaryAction.addEventListener('click', runPrimaryAction);
elements.checkPage.addEventListener('click', () => sendRunAction('JOB_RUN_CHECK_PAGE'));
elements.advancePage.addEventListener('click', () => sendRunAction('JOB_RUN_ADVANCE_PAGE'));
elements.saveAnswers.addEventListener('click', () => sendRunAction('JOB_RUN_SAVE_ANSWERS'));
for (const container of [elements.actionRequiredList, elements.optionalList]) {
  container.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-field-id]');
    if (button?.dataset.fieldId) focusField(button.dataset.fieldId);
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.answerRecords) {
    chrome.runtime.sendMessage({ type: 'JOB_DATASOURCE_STATE' }).then((response) => {
      if (response?.ok) updateDatasourceSummary(response.datasource);
    }).catch(() => {});
  }
  if (area === 'local' && changes.answerRecords) elements.recordCount.textContent = `${(changes.answerRecords.newValue || []).length} answers`;
  if (area === 'local' && changes.coverMessages) elements.coverMessageCount.textContent = `${(changes.coverMessages.newValue || []).length} cover messages`;
  if (area === 'local' && changes.autoAdvancePages) elements.autoAdvance.checked = Boolean(changes.autoAdvancePages.newValue);
  if (area === 'session' && changes.applicationRun && activeTabId) renderRun(changes.applicationRun.newValue?.[String(activeTabId)] || null);
});
if (chrome.tabs?.onActivated?.addListener) {
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    setSaveFeedback();
    activeTabId = tabId;
    refresh().catch((error) => setStatus(error.message, 'error'));
  });
}

refresh().catch((error) => setStatus(error.message, 'error'));
