const byId = (id) => document.getElementById(id);
const elements = {
  provider: byId('ai-provider'),
  fireworksApiKey: byId('fireworks-api-key'),
  openaiApiKey: byId('openai-api-key'),
  apiKey: byId('openai-api-key'),
  apiModel: byId('ai-model'),
  autoAdvance: byId('auto-advance-pages'),
  employerName: byId('employer-name'),
  relatedDefault: byId('related-default'),
  knownDefault: byId('known-default'),
  phoneDeviceDefault: byId('phone-device-default'),
  recordCount: byId('record-count'),
  coverMessageCount: byId('cover-message-count'),
  datasourceHint: byId('datasource-hint'),
  learnedChangeCount: byId('learned-change-count'),
  learnedChangeList: byId('learned-change-list'),
  learningInboxCount: byId('learning-inbox-count'),
  learningInboxList: byId('learning-inbox-list'),
  exportDatasource: byId('export-datasource'),
  importDatasourceButton: byId('import-datasource-button'),
  importDatasource: byId('import-datasource'),
  primaryAction: byId('primary-action'),
  secondaryActions: byId('secondary-actions'),
  checkPage: byId('check-page'),
  advancePage: byId('advance-page'),
  saveAnswers: byId('save-answers'),
  saveFeedback: byId('save-feedback'),
  employmentChoices: byId('employment-choices'),
  retryAi: byId('retry-ai'),
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
let currentProfile = null;
let runRevision = 0;
const correctionDrafts = new Map();
const drafts = new Map();

function draftKey(origin, fieldId) {
  return [origin?.applicationId || '', origin?.pageSignature || '', fieldId || ''].join(':');
}

function draftFor(origin, fieldId) {
  const key = draftKey(origin, fieldId);
  if (!drafts.has(key)) {
    drafts.set(key, {
      answer: '', sourceKey: null, sourceKeys: [], candidateKind: null, editing: false, revision: 0, pending: null,
      rewriteInstruction: '', searchQuery: '', jobDescription: '',
    });
  }
  const draft = drafts.get(key);
  draft.sourceKeys = Array.isArray(draft.sourceKeys) ? draft.sourceKeys : [];
  draft.revision = Number.isInteger(draft.revision) ? draft.revision : 0;
  draft.pending = draft.pending || null;
  draft.rewriteInstruction = String(draft.rewriteInstruction || '');
  draft.searchQuery = String(draft.searchQuery || '');
  draft.jobDescription = String(draft.jobDescription || '');
  return draft;
}

function clearDraft(origin, fieldId) {
  drafts.delete(draftKey(origin, fieldId));
}

function hasCandidateOrigin(state) {
  return Boolean(state.candidateKind || state.sourceKey || state.sourceKeys?.length);
}

function updateDraftAnswer(state, answer) {
  state.answer = String(answer ?? '');
  state.revision += 1;
}

function discardStaleDrafts(run) {
  const origin = `${run?.applicationId || ''}:${run?.pageSignature || ''}:`;
  for (const key of drafts.keys()) {
    if (!run || !key.startsWith(origin)) drafts.delete(key);
  }
}

function fieldOrigin(item) {
  const suggestion = item.suggestion || item.generatedSuggestion || {};
  const field = suggestion.field || {};
  return {
    tabId: suggestion.tabId ?? activeTabId,
    frameId: suggestion.frameId ?? item.frameId ?? currentRun?.frame?.frameId ?? currentRun?.frameId,
    applicationId: suggestion.applicationId ?? currentRun?.applicationId,
    pageSignature: suggestion.pageSignature ?? currentRun?.pageSignature,
    fieldId: field.id ?? item.fieldId,
    handle: field.handle ?? item.handle,
  };
}

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
  renderLearningInbox(datasource.learningInbox || []);
  if (datasource.profile) {
    currentProfile = structuredClone(datasource.profile);
    elements.employerName.value = datasource.profile.employment?.[0]?.company || 'DeepSight AI Labs';
    elements.relatedDefault.value = datasource.profile.defaults?.relatedToHiringCompany || 'Unknown';
    elements.knownDefault.value = datasource.profile.defaults?.knownAtHiringCompany || 'Unknown';
    elements.phoneDeviceDefault.value = datasource.profile.defaults?.phoneDeviceType || 'Unknown';
  }
}

function renderLearningInbox(items) {
  elements.learningInboxCount.textContent = String(items.length);
  elements.learningInboxList.replaceChildren();
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'result-item';
    const label = document.createElement('strong');
    label.textContent = item.proposal?.displayLabel || item.candidate?.label || 'Needs a friendly field label';
    const detail = document.createElement('p');
    detail.className = 'result-detail';
    detail.textContent = item.proposal?.outcome === 'propose' ? `Tags: ${(item.proposal.topicTags || []).join(', ') || 'none'}. Review before this answer can be suggested.` : 'This field could not be safely classified. It remains a local application draft only.';
    row.append(label, detail);
    for (const action of ['approve', 'discard']) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = action === 'approve' ? 'Approve for suggestions' : 'Discard'; button.disabled = action === 'approve' && item.proposal?.outcome !== 'propose';
      button.addEventListener('click', async () => { const response = await chrome.runtime.sendMessage({ type: 'JOB_LEARNING_INBOX_RESOLVE', id: item.id, action }); if (!response?.ok) { setStatus(response?.error || 'Could not update learning proposal.', 'error'); return; } updateDatasourceSummary(response.datasource); setStatus(action === 'approve' ? 'Learning proposal approved.' : 'Learning proposal discarded.'); });
      row.append(button);
    }
    elements.learningInboxList.append(row);
  }
  if (!items.length) elements.learningInboxList.textContent = 'No learning proposals waiting for review.';
}

function renderLearnedChanges(records) {
  elements.learnedChangeCount.textContent = String(records.length);
  elements.learnedChangeList.replaceChildren();
  for (const record of records) {
    const row = itemRow(record);
    const previous = document.createElement('p');
    previous.className = 'change-history';
    const values = [...new Set([...(record.history || []).map((item) => item.answer), ...(record.alternatives || [])])];
    const readableValues = values.filter((value) => !isOpaqueIdentifier(value));
    const context = isOpaqueIdentifier(record.context) ? '' : String(record.context || '');
    previous.textContent = `${record.confirmationState === 'pending' ? 'Needs confirmation. ' : 'Saved locally. '}${context}${readableValues.length ? ` Previous or alternate values: ${readableValues.join('; ')}` : ''}`;
    const hiddenValues = [...new Set([record.answer, record.pendingAnswer, ...values].filter((value) => isOpaqueIdentifier(value)))];
    if (hiddenValues.length) {
      if (previous.textContent && !/\s$/.test(previous.textContent)) previous.append(document.createTextNode(' '));
      previous.append(document.createTextNode('Internal value hidden: '));
      hiddenValues.forEach((value, index) => {
        if (index) previous.append(document.createTextNode(' '));
        previous.append(internalIdDisclosure(value, 'Internal answer ID'));
      });
    }
    if (!previous.textContent) previous.textContent = 'Saved locally.';
    const correction = document.createElement('div');
    correction.className = 'correction-row';
    const input = document.createElement('input');
    const initialValue = correctionDrafts.has(record.key) ? correctionDrafts.get(record.key) : record.pendingAnswer || record.answer || '';
    input.value = isOpaqueIdentifier(initialValue) ? '' : String(initialValue);
    if (isOpaqueIdentifier(initialValue)) input.placeholder = 'Enter a readable answer to replace the hidden internal value';
    input.addEventListener('input', () => correctionDrafts.set(record.key, input.value));
    const question = String(record.question || record.key || 'this saved field');
    const readableQuestion = isOpaqueIdentifier(question) ? 'this saved field' : question;
    input.setAttribute('aria-label', `Correct ${readableQuestion}`);
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

function isOpaqueIdentifier(value) {
  const text = String(value ?? '').trim();
  const distinctHexCharacters = new Set(text.toLowerCase()).size;
  const looksLikeHexHash = /^[a-f\d]{24,}$/i.test(text) && (/\d/.test(text) || distinctHexCharacters >= 3);
  return looksLikeHexHash
    || /^(?:[a-z][a-z\d_-]*\|)?[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}(?:\[[a-z\d_-]+\])?$/i.test(text);
}

function logOpaqueIdentifier(kind, value) {
  console.debug('[Job Application Autofill] Opaque identifier omitted from panel.', { kind, value: String(value ?? '') });
}

let internalIdCounter = 0;

function legacyInternalIdPopover(value, label = 'Internal ID') {
  const wrapper = document.createElement('span');
  wrapper.className = 'internal-id';
  wrapper.dataset.internalId = 'true';
  const popoverId = `internal-id-${++internalIdCounter}`;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'internal-id-trigger';
  trigger.textContent = 'i';
  trigger.title = `Show ${label.toLowerCase()}`;
  trigger.setAttribute('aria-label', `Show ${label.toLowerCase()}`);
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', popoverId);
  trigger.dataset.internalIdTrigger = 'true';
  const popover = document.createElement('span');
  popover.className = 'internal-id-popover';
  popover.id = popoverId;
  popover.hidden = true;
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', label);
  popover.dataset.internalIdPopover = 'true';
  const popoverLabel = document.createElement('span');
  popoverLabel.className = 'internal-id-label';
  popoverLabel.textContent = label;
  const raw = document.createElement('code');
  raw.className = 'internal-id-value';
  raw.dataset.internalValue = 'true';
  raw.textContent = String(value ?? '');
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'internal-id-copy';
  copy.textContent = 'Copy ID';
  copy.dataset.copyInternalId = 'true';
  copy.addEventListener('click', async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(String(value ?? ''));
      copy.textContent = 'Copied';
      copy.dataset.state = 'success';
    } catch {
      copy.textContent = 'Select ID to copy';
      copy.dataset.state = 'error';
    }
  });
  popover.append(popoverLabel, raw, copy);
  const setOpen = (open) => {
    popover.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  };
  let pointerDown = false;
  let focusOpened = false;
  let suppressFocusOpen = false;
  trigger.addEventListener('pointerdown', () => { pointerDown = true; });
  trigger.addEventListener('click', () => {
    // Pointer focus fires before click; avoid opening and immediately closing
    // the popover in that sequence. Programmatic clicks after focus should
    // likewise leave a focus-opened disclosure available to inspect.
    if (pointerDown) {
      focusOpened = false;
      setOpen(popover.hidden);
      pointerDown = false;
    } else if (focusOpened) {
      focusOpened = false;
      setOpen(true);
    } else setOpen(popover.hidden);
  });
  trigger.addEventListener('focus', () => {
    if (!pointerDown && !suppressFocusOpen) {
      focusOpened = true;
      setOpen(true);
    }
  });
  trigger.addEventListener('blur', () => { focusOpened = false; pointerDown = false; });
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      focusOpened = false;
      setOpen(false);
      suppressFocusOpen = true;
      trigger.focus();
      suppressFocusOpen = false;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      focusOpened = false;
      setOpen(popover.hidden);
    }
  });
  popover.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      focusOpened = false;
      setOpen(false);
      suppressFocusOpen = true;
      trigger.focus();
      suppressFocusOpen = false;
    }
  });
  wrapper.append(trigger, popover);
  return wrapper;
}

function internalIdDisclosure(value, label = 'Internal ID') {
  logOpaqueIdentifier(label, value);
  return document.createDocumentFragment();
}

function answerNode(answer, detailKey = '') {
  const text = String(answer ?? '');
  if (text.length <= 180) {
    const span = document.createElement('span');
    span.textContent = text;
    return span;
  }
  const details = document.createElement('details');
  details.className = 'answer-details';
  if (detailKey) details.dataset.panelDetail = detailKey;
  const summary = document.createElement('summary');
  summary.textContent = `${truncateAnswer(text)} (show full)`;
  const full = document.createElement('div');
  full.className = 'answer-full';
  full.textContent = text;
  details.append(summary, full);
  return details;
}

function panelDetailKey(origin, kind, suffix = '') {
  return [origin.applicationId || '', origin.pageSignature || '', origin.fieldId || '', kind, suffix].join(':');
}

function answerWorkspace(item, displayLabel) {
  const origin = fieldOrigin(item);
  const state = draftFor(origin, origin.fieldId);
  const workspace = document.createElement('section');
  workspace.className = 'answer-workspace';
  const workspaceLabel = document.createElement('label');
  workspaceLabel.textContent = 'Answer to send to the form';
  const textarea = document.createElement('textarea');
  textarea.className = 'answer-draft';
  textarea.dataset.answerDraft = 'true';
  textarea.value = state.answer;
  textarea.placeholder = item.generatedSuggestion ? 'Choose an AI draft, or write your own.' : item.suggestion ? 'Choose a saved answer, or write your own.' : 'Write the answer you want to send to the form.';
  textarea.setAttribute('aria-label', `Answer for ${displayLabel}`);
  textarea.readOnly = Boolean(item.suggestion && !state.editing);
  workspaceLabel.htmlFor = `answer-draft-${draftKey(origin, origin.fieldId)}`;
  textarea.id = workspaceLabel.htmlFor;

  const controls = document.createElement('div');
  controls.className = 'answer-workspace-controls';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.dataset.editAnswer = 'true';
  edit.textContent = 'Edit';
  const rewrite = document.createElement('button');
  rewrite.type = 'button';
  rewrite.dataset.rewriteAnswer = 'true';
  rewrite.textContent = 'Ask AI to rewrite';
  const send = document.createElement('button');
  send.type = 'button';
  send.dataset.sendAnswer = 'true';
  send.textContent = 'Send to form';
  send.className = 'answer-send';

  const promptRow = document.createElement('div');
  promptRow.className = 'rewrite-prompt-row';
  promptRow.hidden = true;
  const prompt = document.createElement('textarea');
  prompt.dataset.rewritePrompt = 'true';
  prompt.value = state.rewriteInstruction;
  prompt.maxLength = 1000;
  prompt.placeholder = 'For example: make this more concise and confident.';
  prompt.setAttribute('aria-label', `Rewrite instruction for ${displayLabel}`);
  const submitRewrite = document.createElement('button');
  submitRewrite.type = 'button';
  submitRewrite.dataset.submitRewrite = 'true';
  submitRewrite.textContent = 'Rewrite draft';
  promptRow.append(prompt, submitRewrite);

  const updateControls = () => {
    const hasAnswer = Boolean(state.answer.trim()) && !isOpaqueIdentifier(state.answer);
    const pending = Boolean(state.pending);
    textarea.readOnly = Boolean(item.suggestion && !state.editing);
    textarea.disabled = pending;
    prompt.disabled = pending;
    edit.disabled = pending || !state.answer.trim();
    rewrite.disabled = pending || !state.answer.trim();
    submitRewrite.disabled = pending || !state.answer.trim() || !prompt.value.trim();
    send.disabled = pending || !hasAnswer;
  };
  textarea.addEventListener('input', () => {
    updateDraftAnswer(state, textarea.value);
    state.sourceKey = state.sourceKey || null;
    updateControls();
  });
  edit.addEventListener('click', () => {
    state.editing = true;
    textarea.readOnly = false;
    updateControls();
    textarea.focus();
  });
  rewrite.addEventListener('click', () => {
    promptRow.hidden = false;
    prompt.focus();
  });
  prompt.addEventListener('input', () => {
    state.rewriteInstruction = prompt.value;
    updateControls();
  });
  submitRewrite.addEventListener('click', async () => {
    const instruction = prompt.value.trim();
    if (!instruction || !state.answer.trim()) return;
    const requestRevision = state.revision;
    const requestDraft = state.answer;
    state.pending = 'rewrite';
    updateControls();
    try {
      const response = await chrome.runtime.sendMessage({ type: 'JOB_RUN_REWRITE_ANSWER', ...origin,
        fieldId: origin.fieldId, draft: requestDraft, sourceKey: state.sourceKey, sourceKeys: state.sourceKeys,
        question: displayLabel, instruction });
      if (!response?.ok || typeof response.answer !== 'string') throw new Error(response?.error || 'Could not rewrite the answer.');
      if (state.revision !== requestRevision) {
        setStatus('Draft changed while the rewrite was running. Your latest edit was kept.');
        return;
      }
      updateDraftAnswer(state, response.answer);
      state.editing = false;
      textarea.value = state.answer;
      setStatus('Draft rewritten. Review or edit it before sending it to the form.');
    } catch (error) { setStatus(error.message, 'error'); }
    finally {
      if (state.pending === 'rewrite') state.pending = null;
      updateControls();
    }
  });
  const applyAnswer = async () => {
    const answer = state.answer;
    if (!answer.trim() || isOpaqueIdentifier(answer)) return;
    const requestRevision = state.revision;
    const candidateBacked = hasCandidateOrigin(state);
    state.pending = 'apply';
    updateControls();
    try {
      const type = candidateBacked ? 'JOB_RUN_APPROVE_SUGGESTION' : 'JOB_RUN_APPLY_DRAFT';
      const response = await chrome.runtime.sendMessage({ type, ...origin, fieldId: origin.fieldId, answer,
        ...(candidateBacked ? {
          ...(state.sourceKey ? { sourceKey: state.sourceKey } : {}),
          ...(state.sourceKeys.length ? { sourceKeys: state.sourceKeys } : {}),
          ...(state.candidateKind ? { candidateKind: state.candidateKind } : {}),
        } : {}) });
      if (!response?.ok) throw new Error(response?.error || 'Could not send the answer to the form.');
      if (!response.run) throw new Error('Could not confirm the updated application state. Your draft was kept.');
      if (state.revision === requestRevision) clearDraft(origin, origin.fieldId);
      renderRun(response.run);
      if (state.revision !== requestRevision) {
        setStatus('The form received the earlier draft. Your newer edit was kept.');
      } else {
        setStatus('Answer applied and verified. Submission remains manual.');
      }
    } catch (error) { setStatus(error.message, 'error'); }
    finally {
      if (state.pending === 'apply') state.pending = null;
      updateControls();
    }
  };
  send.addEventListener('click', applyAnswer);
  controls.append(edit, rewrite, send);
  workspace.append(workspaceLabel, textarea, controls, promptRow);
  updateControls();
  return { workspace, state, origin, updateControls, applyAnswer };
}

function itemRow(item, { focus = false, detail = '' } = {}) {
  const row = document.createElement('div');
  row.className = 'result-item';
  const content = document.createElement('div');
  const origin = fieldOrigin(item);
  const candidates = Array.isArray(item.suggestion?.candidates) ? item.suggestion.candidates : [];
  const readableCandidates = candidates.filter((candidate) => !isOpaqueIdentifier(candidate.answer));
  const onlyOpaqueSuggestions = candidates.length > 0 && readableCandidates.length === 0;
  const generated = item.generatedSuggestion;
  const hasReadableGeneratedDraft = Array.isArray(generated?.suggestions)
    && generated.suggestions.some((suggestion) => !isOpaqueIdentifier(suggestion.answer));
  const labelCandidates = [item.label, item.question, item.fieldId].filter(Boolean).map((value) => String(value));
  const rawLabel = labelCandidates.find((value) => isOpaqueIdentifier(value));
  const displayLabel = labelCandidates.find((value) => !isOpaqueIdentifier(value)) || (rawLabel ? 'Form question' : 'Field');
  const itemValue = item.value ?? item.answer;
  const hasOpaqueValue = isOpaqueIdentifier(itemValue);
  const unclearQuestion = item.labelConfidence === 'low';
  const fieldAction = focus && item.fieldId
    ? onlyOpaqueSuggestions
      ? `Choose a value for ${displayLabel} on the application page, then click Check again.`
      : hasOpaqueValue
        ? 'This saved value cannot be used automatically.'
        : itemValue
          ? 'Update this value on the application page, then click Check again.'
          : 'Enter or select an answer on the application page, then click Check again.'
    : '';
  const hasPrimaryDetail = Boolean(detail || onlyOpaqueSuggestions || itemValue || fieldAction);
  const label = document.createElement('h3');
  label.className = 'result-label';
  label.textContent = displayLabel;
  if (rawLabel) label.append(document.createTextNode(' '), internalIdDisclosure(rawLabel, 'Internal field ID'));
  const value = document.createElement('span');
  value.className = 'result-detail';
  if (detail) value.textContent = detail;
  else if (onlyOpaqueSuggestions) value.textContent = fieldAction;
  else if (hasOpaqueValue) {
    value.append(document.createTextNode(`${fieldAction || 'This saved value cannot be used automatically.'} `));
    value.append(internalIdDisclosure(itemValue, 'Internal answer ID'));
  } else if (itemValue) value.append(answerNode(itemValue, panelDetailKey(origin, 'value')));
  else if (unclearQuestion) value.textContent = `${item.nearbyContext ? `Nearby text: ${item.nearbyContext}. ` : ''}Use Show on page to identify this question, then write your answer.`;
  else value.textContent = fieldAction || item.reason || 'Review this field';
  content.append(label, value);
  if (item.reason && hasPrimaryDetail) {
    const reason = document.createElement('p');
    reason.className = 'result-reason';
    reason.textContent = item.reason;
    content.append(reason);
  }
  if (fieldAction && itemValue && !hasOpaqueValue && !onlyOpaqueSuggestions) {
    const nextAction = document.createElement('p');
    nextAction.className = 'result-next-action';
    nextAction.textContent = fieldAction;
    content.append(nextAction);
  }

  if (focus && item.fieldId) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'inline-action';
    button.dataset.fieldId = item.fieldId;
    button.textContent = 'Show on page';
    content.append(button);
  }
  const workspace = focus && item.fieldId && (!onlyOpaqueSuggestions || hasReadableGeneratedDraft)
    ? answerWorkspace(item, displayLabel)
    : null;
  if (workspace) content.append(workspace.workspace);
  if (workspace) {
    const search = document.createElement('div');
    search.className = 'answer-search';
    const query = document.createElement('input');
    query.dataset.searchQuery = 'true';
    query.placeholder = 'Search saved answers';
    query.value = workspace.state.searchQuery;
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.searchAnswers = 'true'; button.textContent = 'Search';
    const results = document.createElement('div');
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({ type: 'JOB_RUN_SEARCH_ANSWERS', ...origin, fieldId: origin.fieldId, query: workspace.state.searchQuery.trim() });
        if (!response?.ok) throw new Error(response?.error || 'Could not search saved answers.');
        results.replaceChildren();
        for (const candidate of response.candidates || []) {
          if (isOpaqueIdentifier(candidate.answer)) continue;
          const choice = document.createElement('button'); choice.type = 'button'; choice.dataset.searchResult = 'true'; choice.textContent = candidate.answer;
          choice.addEventListener('click', () => {
            updateDraftAnswer(workspace.state, candidate.answer); workspace.state.sourceKey = candidate.sourceKey || null;
            workspace.state.sourceKeys = candidate.sourceKeys || (candidate.sourceKey ? [candidate.sourceKey] : []); workspace.state.candidateKind = candidate.kind || null;
            workspace.state.editing = true; workspace.workspace.querySelector('[data-answer-draft]').value = candidate.answer; workspace.updateControls();
          });
          results.append(choice);
        }
        if (!results.children.length) results.textContent = 'No saved answers found.';
      } catch (error) { setStatus(error.message, 'error'); } finally { button.disabled = false; }
    });
    query.addEventListener('input', () => { workspace.state.searchQuery = query.value; });
    search.append(query, button, results); content.append(search);
  }
  if (generated) {
    const drafts = Array.isArray(generated.suggestions) ? generated.suggestions : [];
    const draftList = document.createElement('div');
    draftList.className = 'generated-drafts';
    const heading = document.createElement('p');
    heading.className = 'generated-drafts-heading';
    heading.textContent = drafts.length ? 'Suggested answers' : 'More context needed';
    draftList.append(heading);
    for (const suggestion of drafts) {
      if (isOpaqueIdentifier(suggestion.answer)) continue;
      const draft = document.createElement('div');
      draft.className = 'generated-draft';
      const choose = document.createElement('button');
      choose.type = 'button';
      choose.dataset.chooseGeneratedAnswer = 'true';
      choose.textContent = 'Use this answer';
      choose.addEventListener('click', () => {
        if (!workspace) return;
        updateDraftAnswer(workspace.state, suggestion.answer);
        workspace.state.sourceKey = null;
        workspace.state.sourceKeys = [];
        workspace.state.candidateKind = null;
        workspace.state.editing = true;
        workspace.workspace.querySelector('[data-answer-draft]').value = workspace.state.answer;
        workspace.updateControls();
        void workspace.applyAnswer();
      });
      const editDraft = document.createElement('button');
      editDraft.type = 'button';
      editDraft.dataset.editGeneratedAnswer = 'true';
      editDraft.textContent = 'Edit';
      editDraft.addEventListener('click', () => {
        if (!workspace) return;
        updateDraftAnswer(workspace.state, suggestion.answer);
        workspace.state.sourceKey = null;
        workspace.state.sourceKeys = [];
        workspace.state.candidateKind = null;
        workspace.state.editing = true;
        const draftInput = workspace.workspace.querySelector('[data-answer-draft]');
        draftInput.value = workspace.state.answer;
        workspace.updateControls();
        draftInput.focus();
      });
      draft.append(answerNode(suggestion.answer, panelDetailKey(origin, 'generated', String(draftList.children.length))), choose, editDraft);
      draftList.append(draft);
    }
    if (generated.missingContext) {
      const context = document.createElement('p');
      context.className = 'generated-drafts-context';
      context.textContent = generated.missingContext;
      draftList.append(context);
    }
    const regenerate = document.createElement('button');
    regenerate.type = 'button';
    regenerate.className = 'inline-action';
    regenerate.dataset.generateSuggestions = 'true';
    regenerate.textContent = drafts.length ? 'Generate again' : 'Generate suggestions';
    regenerate.addEventListener('click', async () => {
      if (!workspace) return;
      const jobDescription = String(draftList.querySelector('[data-job-description]')?.value ?? workspace.state.jobDescription).trim();
      workspace.state.jobDescription = jobDescription;
      const actionRevision = runRevision;
      workspace.state.pending = 'generate';
      workspace.updateControls();
      regenerate.disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({ type: 'JOB_RUN_GENERATE_SUGGESTIONS', ...workspace.origin, jobDescription });
        if (!response?.ok || !response.run) throw new Error(response?.error || 'Could not generate answer suggestions.');
        if (canRenderActionResponse(response.run, actionRevision)) {
          renderRun(response.run);
          setStatus('New suggestions are ready for review.');
        } else setStatus('The page changed while suggestions were prepared. Check the page again.', 'error');
      } catch (error) { setStatus(error.message, 'error'); }
      finally {
        workspace.state.pending = null;
        workspace.updateControls();
      }
    });
    if (generated.missingContext && !currentRun?.jobContext?.jobDescription) {
      const details = document.createElement('details');
      details.className = 'job-description-editor';
      details.dataset.panelDetail = panelDetailKey(origin, 'job-description');
      const summary = document.createElement('summary');
      summary.textContent = 'Add job description';
      const input = document.createElement('textarea');
      input.dataset.jobDescription = 'true';
      input.value = workspace.state.jobDescription;
      input.maxLength = 16000;
      input.placeholder = 'Paste the job description to tailor suggestions.';
      input.setAttribute('aria-label', `Job description for ${displayLabel}`);
      input.addEventListener('input', () => { workspace.state.jobDescription = input.value; });
      details.append(summary, input);
      draftList.append(details);
    }
    draftList.append(regenerate);
    content.insertBefore(draftList, workspace?.workspace || null);
  }
  if (item.suggestion) {
    for (const candidate of candidates) {
      const evidence = document.createElement('details');
      evidence.className = 'saved-evidence';
      evidence.dataset.panelDetail = panelDetailKey(origin, 'evidence', candidate.sourceKey || String(candidates.indexOf(candidate)));
      const summary = document.createElement('summary');
      const sourceQuestion = String(candidate.sourceQuestion || 'Saved answer');
      if (isOpaqueIdentifier(sourceQuestion)) {
        summary.textContent = 'Saved answer from a previous form';
        logOpaqueIdentifier('saved answer source', sourceQuestion);
      } else summary.textContent = `Saved answer from ${sourceQuestion}`;
      if (isOpaqueIdentifier(candidate.answer)) {
        const unavailable = document.createElement('p');
        unavailable.className = 'result-detail';
        unavailable.textContent = 'This saved value cannot be used automatically.';
        logOpaqueIdentifier('saved answer', candidate.answer);
        evidence.append(summary, unavailable);
        content.append(evidence);
        continue;
      }
      const answer = document.createElement('p');
      answer.className = 'saved-evidence-answer';
      answer.dataset.savedAnswerText = 'true';
      answer.textContent = candidate.answer;
      const reason = document.createElement('p');
      reason.className = 'saved-evidence-reason';
      reason.textContent = candidate.reason || '';
      const choose = document.createElement('button');
      choose.type = 'button';
      choose.dataset.chooseAnswer = 'true';
      choose.textContent = 'Use answer';
      choose.addEventListener('click', () => {
        if (!workspace) return;
        updateDraftAnswer(workspace.state, candidate.answer);
        workspace.state.sourceKey = candidate.sourceKey || null;
        workspace.state.sourceKeys = Array.isArray(candidate.sourceKeys) ? candidate.sourceKeys : (candidate.sourceKey ? [candidate.sourceKey] : []);
        workspace.state.candidateKind = candidate.kind || null;
        workspace.state.editing = false;
        const draft = workspace.workspace.querySelector('[data-answer-draft]');
        draft.value = workspace.state.answer;
        workspace.updateControls();
        void workspace.applyAnswer();
      });
      const editCandidate = document.createElement('button');
      editCandidate.type = 'button';
      editCandidate.dataset.editCandidate = 'true';
      editCandidate.textContent = 'Edit';
      editCandidate.addEventListener('click', () => {
        if (!workspace) return;
        updateDraftAnswer(workspace.state, candidate.answer);
        workspace.state.sourceKey = candidate.sourceKey || null;
        workspace.state.sourceKeys = Array.isArray(candidate.sourceKeys) ? candidate.sourceKeys : (candidate.sourceKey ? [candidate.sourceKey] : []);
        workspace.state.candidateKind = candidate.kind || null;
        workspace.state.editing = true;
        const draft = workspace.workspace.querySelector('[data-answer-draft]');
        draft.value = workspace.state.answer;
        workspace.updateControls();
        draft.focus();
      });
      evidence.append(summary, answer);
      if (reason.textContent) evidence.append(reason);
      evidence.append(choose, editCandidate);
      const sourceKeys = Array.isArray(candidate.sourceKeys) ? candidate.sourceKeys : [candidate.sourceKey].filter(Boolean);
      if (candidate.kind !== 'draft' && candidate.kind !== 'planner' && sourceKeys.length === 1) {
        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.dataset.dismissSavedAnswer = 'true';
        dismiss.textContent = 'Not relevant to this question';
        dismiss.addEventListener('click', async () => {
          dismiss.disabled = true;
          try {
            const response = await chrome.runtime.sendMessage({ type: 'JOB_DATASOURCE_SUPPRESS_ANSWER', tabId: origin.tabId, fieldId: origin.fieldId, sourceKey: candidate.sourceKey });
            if (!response?.ok) throw new Error(response?.error || 'Could not hide this saved answer.');
            if (response.run) renderRun(response.run);
            setStatus('This saved answer will no longer be suggested for this question.');
          } catch (error) { setStatus(error.message, 'error'); }
          finally { dismiss.disabled = false; }
        });
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.dataset.deleteSavedAnswer = 'true';
        remove.textContent = 'Delete saved answer';
        const confirmation = document.createElement('span');
        confirmation.className = 'saved-answer-delete-confirmation';
        confirmation.hidden = true;
        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.dataset.confirmDeleteSavedAnswer = 'true';
        confirm.textContent = 'Delete permanently';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = 'Cancel';
        remove.addEventListener('click', () => { remove.hidden = true; confirmation.hidden = false; confirm.focus(); });
        cancel.addEventListener('click', () => { confirmation.hidden = true; remove.hidden = false; });
        confirm.addEventListener('click', async () => {
          confirm.disabled = true;
          try {
            const response = await chrome.runtime.sendMessage({ type: 'JOB_DATASOURCE_DELETE_ANSWER', tabId: origin.tabId, fieldId: origin.fieldId, sourceKey: candidate.sourceKey });
            if (!response?.ok) throw new Error(response?.error || 'Could not delete this saved answer.');
            if (response.run) renderRun(response.run);
            setStatus('Saved answer deleted.');
          } catch (error) { setStatus(error.message, 'error'); }
          finally { confirm.disabled = false; }
        });
        confirmation.append(confirm, cancel);
        evidence.append(dismiss, remove, confirmation);
      }
      content.append(evidence);
    }
  }
  row.append(content);
  return row;
}

function renderList(container, items, options = {}) {
  container.replaceChildren();
  if (!items.length) {
    container.append(itemRow({ label: options.emptyLabel || 'None' }, { detail: options.emptyDetail || 'Nothing to review.' }));
    return;
  }
  const ordered = items.map((item, index) => ({ item, index })).sort((left, right) => {
    const leftGeneric = !left.item.fieldId && !left.item.key && !left.item.question;
    const rightGeneric = !right.item.fieldId && !right.item.key && !right.item.question;
    if (leftGeneric !== rightGeneric) return leftGeneric ? 1 : -1;
    const leftPage = Number.isFinite(left.item.pageNumber) ? left.item.pageNumber : null;
    const rightPage = Number.isFinite(right.item.pageNumber) ? right.item.pageNumber : null;
    if (leftPage !== rightPage) {
      if (leftPage == null) return 1;
      if (rightPage == null) return -1;
      return leftPage - rightPage;
    }
    const leftOrder = Number.isFinite(left.item.formOrder) ? left.item.formOrder : null;
    const rightOrder = Number.isFinite(right.item.formOrder) ? right.item.formOrder : null;
    if (leftOrder != null && rightOrder != null && leftOrder !== rightOrder) return leftOrder - rightOrder;
    if (leftOrder != null && rightOrder == null) return -1;
    if (leftOrder == null && rightOrder != null) return 1;
    return left.index - right.index;
  });
  for (const { item } of ordered) container.append(itemRow(item, options));
}

function setActionVisibility(run) {
  const status = run?.status;
  const hasRun = Boolean(run);
  elements.primaryAction.disabled = busy || status === 'running';
  for (const button of [elements.checkPage, elements.advancePage, elements.saveAnswers]) {
    button.disabled = busy || status === 'running';
  }
  elements.primaryAction.hidden = false;
  elements.checkPage.hidden = !['waiting_user', 'page_ready'].includes(status);
  // The primary action carries the state-specific Continue/Save copy. Keep the
  // secondary row focused on the safe, repeatable “Check again” action.
  elements.advancePage.hidden = true;
  elements.saveAnswers.hidden = !['waiting_user', 'page_ready', 'ready_for_user_submit', 'answers_saved'].includes(status);
  elements.saveAnswers.textContent = saving ? 'Saving…' : (['ready_for_user_submit', 'answers_saved'].includes(status) ? 'Save draft checkpoint' : 'Save filled values');
  elements.saveAnswers.setAttribute('aria-busy', String(saving));
  elements.secondaryActions.hidden = !hasRun || (elements.checkPage.hidden && elements.advancePage.hidden && elements.saveAnswers.hidden);
  if (!hasRun) {
    elements.primaryAction.textContent = 'Fill this page';
    return;
  }
  if (status === 'running') elements.primaryAction.textContent = 'Filling this page…';
  else if (status === 'waiting_user') elements.primaryAction.textContent = 'Fix first issue';
  else if (status === 'page_ready') elements.primaryAction.textContent = 'Continue to next page';
  else if (['ready_for_user_submit', 'answers_saved'].includes(status)) elements.primaryAction.textContent = 'Review on site';
  else elements.primaryAction.textContent = 'Fill this page';
}

function capturePanelState() {
  const active = document.activeElement;
  const openDetails = Object.fromEntries([...document.querySelectorAll('details')]
    .map((detail) => [detail.dataset.panelDetail || detail.id, detail.open])
    .filter(([key]) => Boolean(key)));
  return {
    activeId: active?.id || '',
    selectionStart: active?.selectionStart, selectionEnd: active?.selectionEnd,
    openDetails,
    scrollX: window.scrollX, scrollY: window.scrollY,
  };
}

function restorePanelState(state) {
  [...document.querySelectorAll('details')].forEach((detail) => {
    const key = detail.dataset.panelDetail || detail.id;
    if (key && Object.hasOwn(state.openDetails, key)) detail.open = state.openDetails[key];
  });
  const active = state.activeId ? document.getElementById(state.activeId) : null;
  if (active) {
    active.focus({ preventScroll: true });
    if (Number.isInteger(state.selectionStart) && active.setSelectionRange) active.setSelectionRange(state.selectionStart, state.selectionEnd);
  }
  const scrollTo = window.scrollTo;
  const supportsNativeScrollTo = typeof scrollTo === 'function'
    && !String(scrollTo).includes('notImplemented');
  if (supportsNativeScrollTo) {
    try {
      scrollTo(state.scrollX, state.scrollY);
    } catch {
      // Ignore environment specific scroll behavior failures.
    }
  }
}

function renderRun(run) {
  const panelState = capturePanelState();
  runRevision += 1;
  const previousOrigin = `${currentRun?.applicationId || ''}:${currentRun?.pageSignature || ''}`;
  const nextOrigin = `${run?.applicationId || ''}:${run?.pageSignature || ''}`;
  if (previousOrigin !== nextOrigin || !run) discardStaleDrafts(run);
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
    restorePanelState(panelState);
    return;
  }

  const actionRequired = run.actionRequired || run.unresolved || [];
  const optionalUnresolved = run.optionalUnresolved || [];
  const reviewRequired = run.reviewRequired || [];
  const audit = run.audit || [];
  const failedAi = Object.values(run.aiOperations || {}).some((operation) => ['failed', 'interrupted'].includes(operation?.status || operation));
  elements.retryAi.hidden = !failedAi;
  elements.employmentChoices.replaceChildren();
  for (const choice of run.employmentChoices || []) {
    const label = document.createElement('label'); label.textContent = choice.label || 'Choose employment';
    const select = document.createElement('select'); select.dataset.employmentChoice = 'true';
    const placeholder = document.createElement('option'); placeholder.textContent = 'Choose an employer'; placeholder.value = ''; select.append(placeholder);
    for (const employer of choice.employers || []) { const option = document.createElement('option'); option.textContent = employer.company || 'Employer'; option.value = employer.id; select.append(option); }
    select.addEventListener('change', async () => {
      if (!select.value) return;
      const response = await chrome.runtime.sendMessage({ type: 'JOB_RUN_SELECT_EMPLOYMENT', tabId: activeTabId, frameId: run.frame?.frameId ?? run.frameId, applicationId: run.applicationId, pageSignature: run.pageSignature, sectionId: choice.sectionId, employmentId: select.value });
      if (!response?.ok) setStatus(response?.error || 'Could not select employment.', 'error'); else if (response.run) renderRun(response.run);
    });
    const group = document.createElement('div'); group.className = 'employment-choice'; group.append(label, select); elements.employmentChoices.append(group);
  }
  const progressLabels = { checking_fields: 'Checking fields…', local_fill_complete: 'Local fill complete', preparing_suggestions: 'Preparing suggestions…', ready: 'Ready' };
  elements.runState.textContent = progressLabels[run.progress] || STATUS_LABELS[run.status] || run.status;
  const accentStatuses = ['waiting_user', 'page_ready', 'ready_for_user_submit', 'answers_saved'];
  elements.runState.className = `pill${accentStatuses.includes(run.status) ? '' : ' neutral'}`;
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
    const waitingLabel = String(run.waitingLabel || '').trim();
    const visibleWaitingLabel = waitingLabel && !isOpaqueIdentifier(waitingLabel) ? waitingLabel : '';
    elements.runHint.textContent = visibleWaitingLabel
      ? `Complete “${visibleWaitingLabel}” on the application page, then click Check again.`
      : 'Complete the highlighted field or handle the manual step, then click Check again.';
    setStatus(run.llmError ? `Answer planner unavailable: ${run.llmError}` : 'Action is required on the application page.', run.llmError ? 'error' : 'ok');
  } else if (run.status === 'page_ready') {
    elements.runHint.textContent = 'This page is filled and validated. Review it, then continue when you are ready.';
    setStatus(`Page ${run.pageNumber || 1} is ready for your approval.`);
  } else if (run.status === 'ready_for_user_submit') {
    elements.runHint.textContent = 'Review the application and the lists below. Your current values are captured automatically when you submit on the site; Save answers is an optional local checkpoint.';
    setStatus('Final page is ready. Submission stays manual; final values are captured automatically.');
  } else if (run.status === 'answers_saved') {
    elements.runHint.textContent = 'Answers are saved locally. Review the application and click Submit on the application site when ready; current values are captured automatically when you submit.';
    setStatus('Answers saved. Submission remains manual.');
  } else if (run.status === 'running') {
    elements.runHint.textContent = `Filling page ${run.pageNumber || 1}. The panel will stop for your review before navigation.`;
    setStatus(`Filling page ${run.pageNumber || 1}…`, 'busy');
  }
  restorePanelState(panelState);
}

function canRenderActionResponse(run, actionRevision) {
  if (runRevision === actionRevision) return true;
  if (!currentRun || !run) return false;
  if (currentRun.applicationId !== run.applicationId || currentRun.pageSignature !== run.pageSignature) return false;
  const currentRevision = Number(currentRun.revision);
  const responseRevision = Number(run.revision);
  return !(Number.isFinite(currentRevision) && Number.isFinite(responseRevision) && responseRevision < currentRevision);
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
  const actionRevision = runRevision;
  setSaveFeedback(saving ? 'Saving filled values…' : '', saving ? 'saving' : '');
  setActionVisibility(currentRun);
  setStatus(saving ? 'Saving filled values…' : 'Working on the current application…', 'busy');
  try {
    const tab = await activeTab();
    const response = await chrome.runtime.sendMessage({ type, tabId: tab.id });
    if (tab.id !== activeTabId) return;
    if (!response?.ok) throw new Error(response?.error || 'The application action could not be completed.');
    if (type === 'JOB_RUN_SAVE_ANSWERS' && response.run && response.run.status === 'ready_for_user_submit' && currentRun?.status === 'ready_for_user_submit') {
      response.run.status = 'answers_saved';
      response.run.waitingFor = null;
      response.run.waitingLabel = null;
    }
    if (response.run && canRenderActionResponse(response.run, actionRevision)) renderRun(response.run);
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
  if (currentRun?.status === 'waiting_user') {
    const first = (currentRun.actionRequired || currentRun.unresolved || [])[0];
    if (first?.fieldId) return focusField(first.fieldId);
  }
  if (['ready_for_user_submit', 'answers_saved'].includes(currentRun?.status)) {
    const first = currentRun.reviewRequired?.[0] || currentRun.audit?.[0];
    if (first?.fieldId || first?.key) return focusField(first.fieldId || first.key);
    setStatus('Review the application on the site before submitting.');
    return;
  }
  const type = !currentRun || currentRun.status === 'answers_saved'
    ? 'JOB_RUN_START'
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
  const stored = await chrome.storage.local.get({ answerRecords: [], openaiApiKey: '', fireworksApiKey: '', aiProvider: '', aiModel: '', openaiModel: 'gpt-5.6-terra', autoAdvancePages: false });
  const provider = stored.aiProvider === 'openai' || stored.aiProvider === 'fireworks'
    ? stored.aiProvider
    : (stored.openaiApiKey ? 'openai' : 'fireworks');
  const defaultModel = provider === 'fireworks' ? 'accounts/fireworks/models/glm-5p3-flash' : 'gpt-5.6-terra';
  elements.provider.value = provider;
  elements.provider.selectedIndex = provider === 'openai' ? 1 : 0;
  elements.fireworksApiKey.value = stored.fireworksApiKey || '';
  elements.openaiApiKey.value = stored.openaiApiKey || '';
  elements.apiModel.value = stored.aiModel || (provider === 'openai' ? stored.openaiModel : '') || defaultModel;
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

async function saveApiKey(input, storageKey, providerLabel) {
  const value = input.value.trim();
  await chrome.storage.local.set({ [storageKey]: value });
  setStatus(value ? `${providerLabel} API key saved in trusted extension storage.` : `${providerLabel} API key cleared. Local answers still work.`);
}

async function saveModel() {
  const model = elements.apiModel.value.trim() || (elements.provider.value === 'fireworks' ? 'accounts/fireworks/models/glm-5p3-flash' : 'gpt-5.6-terra');
  elements.apiModel.value = model;
  await chrome.storage.local.set({ aiModel: model, ...(elements.provider.value === 'openai' ? { openaiModel: model } : {}) });
  setStatus(`Answer planner model saved: ${model}.`);
}

async function saveProvider() {
  const provider = elements.provider.value === 'openai' ? 'openai' : 'fireworks';
  const defaultModel = provider === 'fireworks' ? 'accounts/fireworks/models/glm-5p3-flash' : 'gpt-5.6-terra';
  const currentModel = elements.apiModel.value.trim();
  const previousDefault = provider === 'fireworks' ? 'gpt-5.6-terra' : 'accounts/fireworks/models/glm-5p3-flash';
  if (!currentModel || currentModel === previousDefault) elements.apiModel.value = defaultModel;
  await chrome.storage.local.set({ aiProvider: provider, aiModel: elements.apiModel.value.trim() || defaultModel });
  setStatus(`${provider === 'fireworks' ? 'Fireworks' : 'OpenAI'} is now the active provider.`);
}

async function saveSettings() {
  await chrome.storage.local.set({ autoAdvancePages: Boolean(elements.autoAdvance.checked) });
  setStatus(elements.autoAdvance.checked ? 'Automatic page advance enabled.' : 'Automatic page advance disabled.');
}

async function saveProfile(changedField) {
  try {
    const company = elements.employerName.value.trim() || 'DeepSight AI Labs';
    elements.employerName.value = company;
    const employment = structuredClone(currentProfile?.employment || []);
    if (employment.length) employment[0] = { ...employment[0], company };
    else employment.push({ company });
    const defaultsConfirmation = { ...(currentProfile?.defaultsConfirmation || {}) };
    if (changedField && changedField !== 'employerName') defaultsConfirmation[changedField] = 'confirmed';
    const response = await chrome.runtime.sendMessage({ type: 'JOB_DATASOURCE_PROFILE_UPDATE', profile: {
      ...(currentProfile || {}), employment,
      defaults: {
        relatedToHiringCompany: elements.relatedDefault.value,
        knownAtHiringCompany: elements.knownDefault.value,
        phoneDeviceType: elements.phoneDeviceDefault.value,
      }, defaultsConfirmation,
    } });
    if (!response?.ok) throw new Error(response?.error || 'Could not save profile defaults.');
    updateDatasourceSummary(response.datasource);
    setStatus('Profile defaults saved. They will be used on identified company questions.');
  } catch (error) { setStatus(error.message, 'error'); }
}

for (const [input, key, label] of [[elements.fireworksApiKey, 'fireworksApiKey', 'Fireworks'], [elements.openaiApiKey, 'openaiApiKey', 'OpenAI']]) {
  input.addEventListener('change', () => saveApiKey(input, key, label));
  input.addEventListener('blur', () => saveApiKey(input, key, label));
  input.addEventListener('input', () => saveApiKey(input, key, label));
}
elements.provider.addEventListener('change', saveProvider);
elements.apiModel.addEventListener('change', saveModel);
elements.apiModel.addEventListener('blur', saveModel);
elements.autoAdvance.addEventListener('change', saveSettings);
for (const [field, key] of [[elements.employerName, 'employerName'], [elements.relatedDefault, 'relatedToHiringCompany'], [elements.knownDefault, 'knownAtHiringCompany'], [elements.phoneDeviceDefault, 'phoneDeviceType']]) field.addEventListener('change', () => saveProfile(key));
elements.exportDatasource.addEventListener('click', exportDatasource);
elements.importDatasourceButton.addEventListener('click', () => elements.importDatasource.click());
elements.importDatasource.addEventListener('change', () => importDatasource(elements.importDatasource.files?.[0]));
elements.primaryAction.addEventListener('click', runPrimaryAction);
elements.checkPage.addEventListener('click', () => sendRunAction('JOB_RUN_VALIDATE_PAGE'));
elements.retryAi.addEventListener('click', () => sendRunAction('JOB_RUN_RETRY_AI'));
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
