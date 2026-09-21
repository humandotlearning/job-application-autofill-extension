const byId = (id) => document.getElementById(id);
const elements = {
  provider: byId('ai-provider'),
  fireworksApiKey: byId('fireworks-api-key'),
  openaiApiKey: byId('openai-api-key'),
  typesafeEnabled: byId('typesafe-enabled'),
  typesafeApiKey: byId('typesafe-api-key'),
  apiKey: byId('openai-api-key'),
  apiModel: byId('ai-model'),
  includeFormScreenshot: byId('include-form-screenshot'),
  phoenixTracing: byId('phoenix-tracing'),
  phoenixStatus: byId('phoenix-status'),
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
  fillPage: byId('fill-page'),
  advancePage: byId('advance-page'),
  saveAnswers: byId('save-answers'),
  saveHint: byId('save-hint'),
  saveFeedback: byId('save-feedback'),
  employmentChoices: byId('employment-choices'),
  retryAi: byId('retry-ai'),
  runTitle: byId('run-title'),
  runSummary: byId('run-summary'),
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
  statusDetails: byId('status-details'),
  statusDetail: byId('status-detail'),
  inlineFieldCard: byId('inline-field-card'),
  inlineFieldList: byId('inline-field-list'),
  closeInlineField: byId('close-inline-field'),
  siteControlCard: byId('site-control-card'),
  siteControlTitle: byId('site-control-title'),
  siteControlState: byId('site-control-state'),
  siteControlHint: byId('site-control-hint'),
  siteToggle: byId('site-toggle'),
  disabledSiteCount: byId('disabled-site-count'),
  disabledSiteList: byId('disabled-site-list'),
};

const STATUS_LABELS = {
  running: 'Filling…',
  waiting_user: 'Action required',
  page_ready: 'Page ready',
  ready_for_user_submit: 'Ready to review',
  answers_saved: 'Answers saved',
};

let activeTabId = null;
let currentRun = null;
let currentInlineSession = null;
let inlineLoadRevision = 0;
let inlineRenderSignature = '';
let busy = false;
let saving = false;
let currentProfile = null;
let runRevision = 0;
let currentSite = { hostname: '', supported: false, disabled: false, disabledHostnames: [] };
const correctionDrafts = new Map();
const drafts = new Map();

function draftKey(origin, fieldId) {
  if (origin?.inlineSessionId) return ['inline', origin.tabId, origin.frameId, origin.inlineSessionId, fieldId || ''].join(':');
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
    if (key.startsWith('inline:')) continue;
    if (!run || !key.startsWith(origin)) drafts.delete(key);
  }
}

function fieldOrigin(item) {
  const suggestion = item.suggestion || item.generatedSuggestion || {};
  const field = suggestion.field || {};
  return {
    ...((item.inlineSessionId || suggestion.inlineSessionId) ? {inlineSessionId: item.inlineSessionId || suggestion.inlineSessionId} : {}),
    tabId: suggestion.tabId ?? activeTabId,
    frameId: suggestion.frameId ?? item.frameId ?? currentRun?.frame?.frameId ?? currentRun?.frameId,
    applicationId: suggestion.applicationId ?? currentRun?.applicationId,
    pageSignature: suggestion.pageSignature ?? currentRun?.pageSignature,
    fieldId: field.id ?? item.fieldId,
    handle: field.handle ?? item.handle,
  };
}

function sendFieldAction(type, origin, payload = {}) {
  return chrome.runtime.sendMessage({type, ...origin, ...payload});
}

function renderInlineField(session, {force = false, preserveDrafts = false, preserveContent = false} = {}) {
  if (!session?.panelRequested || session.tabId !== activeTabId) session = null;
  const identity = session ? `${session.tabId}:${session.frameId}:${session.sessionId}` : '';
  for (const key of drafts.keys()) {
    if (!preserveDrafts && key.startsWith(`inline:${activeTabId}:`) && !key.startsWith(`inline:${identity}:`)) drafts.delete(key);
  }
  currentInlineSession = session;
  elements.inlineFieldCard.hidden = !session;
  const signature = JSON.stringify(session && [identity, session.suggestions, session.generatedSuggestions, session.panelCandidateId, session.applied]);
  if (preserveContent) { inlineRenderSignature = signature; return; }
  if (!force && signature === inlineRenderSignature) return;
  // Storage notifications can arrive before the action reply; keep the live
  // editor until its pending operation settles so typing and selection survive.
  if (!force && session && drafts.get(`inline:${identity}:${session.field.id}`)?.pending) return;
  const panelState = capturePanelState();
  inlineRenderSignature = signature;
  elements.inlineFieldList.replaceChildren();
  if (!session) return;
  const field = session.field;
  const origin = {inlineSessionId: session.sessionId, tabId: session.tabId, frameId: session.frameId,
    applicationId: session.attachedRun?.applicationId || session.sessionId, pageSignature: session.pageSignature, field};
  const suggestion = {...session.suggestions?.[field.id], ...origin};
  const generated = session.generatedSuggestions?.[field.id] || {suggestions: []};
  const item = {inlineSessionId: session.sessionId, fieldId: field.id, handle: field.handle, label: field.label,
    suggestion, generatedSuggestion: {...generated, ...origin}};
  const state = draftFor(fieldOrigin(item), field.id);
  if (!state.initialized) {
    state.initialized = true;
    const saved = suggestion.candidates?.find(candidate => candidate.candidateId === session.panelCandidateId);
    const candidate = saved || generated.suggestions?.find(candidate => candidate.candidateId === session.panelCandidateId);
    if (candidate && !isOpaqueIdentifier(candidate.answer)) {
      state.answer = candidate.answer;
      state.sourceKey = saved?.sourceKey || null;
      state.sourceKeys = saved ? sourceKeysForPanelCandidate(saved) : [];
      state.candidateKind = saved?.kind || null;
    }
    state.editing = true;
  }
  elements.inlineFieldList.append(itemRow(item, {focus: true, responseHandler: (response, options = {}) => {
    if (activeTabId !== session.tabId || currentInlineSession?.sessionId !== session.sessionId) return;
    renderInlineField(response.inlineSession, {force: true, ...options});
  }}));
  restorePanelState(panelState);
}

function sourceKeysForPanelCandidate(candidate) {
  return Array.isArray(candidate.sourceKeys) ? candidate.sourceKeys : [candidate.sourceKey].filter(Boolean);
}

async function loadInlineField() {
  const revision = ++inlineLoadRevision, tabId = activeTabId;
  if (!tabId) { renderInlineField(null); return; }
  const response = await chrome.runtime.sendMessage({type: 'JOB_INLINE_PANEL_STATE', tabId});
  if (revision === inlineLoadRevision && tabId === activeTabId && response?.ok) renderInlineField(response.inlineSession);
}

function setSaveFeedback(message = '', state = '') {
  elements.saveFeedback.textContent = message;
  elements.saveFeedback.dataset.state = state;
  elements.saveFeedback.hidden = !message;
}

function setStatus(message, state = 'ok', detail = '') {
  elements.status.textContent = message;
  elements.statusDot.className = `status-dot${state === 'ok' ? '' : ` ${state}`}`;
  elements.statusDetails.hidden = !detail;
  elements.statusDetail.textContent = detail;
  if (!detail) elements.statusDetails.open = false;
}

function renderDisabledSites(hostnames = []) {
  const sites = [...new Set((Array.isArray(hostnames) ? hostnames : []).filter(Boolean))].sort();
  elements.disabledSiteCount.textContent = String(sites.length);
  elements.disabledSiteList.replaceChildren();
  if (!sites.length) {
    const empty = document.createElement('p');
    empty.className = 'hint compact';
    empty.textContent = 'No sites are disabled.';
    elements.disabledSiteList.append(empty);
    return;
  }
  for (const hostname of sites) {
    const row = document.createElement('div');
    row.className = 'disabled-site-row';
    const label = document.createElement('span');
    label.textContent = hostname;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Re-enable ${hostname}`);
    remove.dataset.disabledHostname = hostname;
    remove.disabled = busy;
    row.append(label, remove);
    elements.disabledSiteList.append(row);
  }
}

function renderSiteState(site = {}) {
  currentSite = {
    hostname: String(site.hostname || ''),
    supported: Boolean(site.supported && site.hostname),
    disabled: Boolean(site.disabled && site.hostname),
    disabledHostnames: Array.isArray(site.disabledHostnames) ? [...site.disabledHostnames] : [],
  };
  renderDisabledSites(currentSite.disabledHostnames);
  elements.siteControlCard.hidden = false;
  elements.siteControlTitle.textContent = currentSite.hostname || 'Site access';
  elements.siteControlCard.dataset.disabled = String(currentSite.disabled);
  elements.siteControlState.textContent = !currentSite.supported ? 'Unavailable' : (currentSite.disabled ? 'Disabled' : 'Enabled');
  elements.siteControlState.className = `pill${currentSite.disabled ? '' : ' neutral'}`;
  elements.siteToggle.hidden = !currentSite.supported;
  elements.siteToggle.disabled = busy;
  elements.siteToggle.textContent = currentSite.disabled ? 'Re-enable on this site' : 'Disable on this site';
  elements.siteControlHint.textContent = !currentSite.supported
    ? 'Site controls are unavailable on this browser or extension page.'
    : currentSite.disabled
    ? `Autofill is paused on ${currentSite.hostname}. No page data is inspected, filled, learned, or captured.`
    : `Autofill starts only after you press Fill this form. Disable this site here if it should stay untouched.`;
  setActionVisibility(currentRun);
  if (!currentSite.supported || currentSite.disabled) {
    renderRun(null);
    renderInlineField(null);
  }
}

async function refreshSiteState() {
  const response = await chrome.runtime.sendMessage({ type: 'JOB_SITE_CONTROL_STATE' });
  if (response?.ok && response.site) renderSiteState(response.site);
}

async function toggleSite() {
  if (!currentSite.supported || busy) return;
  busy = true;
  renderSiteState(currentSite);
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'JOB_SITE_SET_DISABLED',
      tabId: activeTabId,
      disabled: !currentSite.disabled,
    });
    if (!response?.ok || !response.site) throw new Error(response?.error || 'Could not update this site setting.');
    renderSiteState(response.site);
    if (response.site.disabled) renderRun(null);
    setStatus(response.site.disabled ? `Autofill disabled on ${response.site.hostname}.` : `Autofill re-enabled on ${response.site.hostname}.`);
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    busy = false;
    renderSiteState(currentSite);
  }
}

async function removeDisabledSite(hostname) {
  if (!hostname || busy) return;
  busy = true;
  renderSiteState(currentSite);
  try {
    const response = await chrome.runtime.sendMessage({ type: 'JOB_SITE_REMOVE_DISABLED', hostname, tabId: activeTabId });
    if (!response?.ok || !response.site) throw new Error(response?.error || 'Could not remove the disabled site.');
    renderSiteState(response.site);
    setStatus(`Autofill settings updated for ${hostname}.`);
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    busy = false;
    renderSiteState(currentSite);
  }
}

function updateDatasourceSummary(datasource = {}) {
  const answerCount = Number(datasource.answerCount || 0);
  const coverMessageCount = Number(datasource.coverMessageCount || 0);
  elements.recordCount.textContent = `${answerCount} answer${answerCount === 1 ? '' : 's'}`;
  elements.coverMessageCount.textContent = `${coverMessageCount} cover message${coverMessageCount === 1 ? '' : 's'}`;
  if (datasource.learnedChanges) renderLearnedChanges(datasource.learnedChanges);
  renderLearningInbox(datasource.learningInbox || [], datasource.undoAvailable === true);
  if (datasource.profile) {
    currentProfile = structuredClone(datasource.profile);
    elements.employerName.value = datasource.profile.employment?.[0]?.company || 'DeepSight AI Labs';
    elements.relatedDefault.value = datasource.profile.defaults?.relatedToHiringCompany || 'Unknown';
    elements.knownDefault.value = datasource.profile.defaults?.knownAtHiringCompany || 'Unknown';
    elements.phoneDeviceDefault.value = datasource.profile.defaults?.phoneDeviceType || 'Unknown';
  }
}

async function refreshPhoenixStatus() {
  if (!elements.phoenixStatus) return;
  const stored = await chrome.storage.local.get({phoenixTraceQueue: [], phoenixTraceStatus: {}});
  const status = stored.phoenixTraceStatus || {};
  status.pending = Array.isArray(stored.phoenixTraceQueue) ? stored.phoenixTraceQueue.length : 0;
  const last = status.lastSuccessAt ? ` Last sent ${new Date(status.lastSuccessAt).toLocaleTimeString()}.` : '';
  const error = status.lastError ? ` Last error: ${status.lastError}.` : '';
  elements.phoenixStatus.textContent = `Phoenix delivery: ${status.pending} pending, ${status.dropped} dropped.${last}${error}`;
}

function renderLearningInbox(items, undoAvailable = false) {
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
  if (undoAvailable) {
    const undo = document.createElement('button');
    undo.type = 'button'; undo.textContent = 'Undo latest automatic save';
    undo.addEventListener('click', async () => {
      const response = await chrome.runtime.sendMessage({ type: 'JOB_DATASOURCE_UNDO_LAST_AUTOSAVE' });
      if (!response?.ok) { setStatus(response?.error || 'Could not undo the automatic save.', 'error'); return; }
      updateDatasourceSummary(response.datasource); setStatus('Latest automatic save undone.');
    });
    elements.learningInboxList.append(undo);
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
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.setAttribute('aria-label', `Close ${readableQuestion} notification without confirming`);
    button.addEventListener('click', async () => {
      button.disabled = close.disabled = true;
      try {
        const submitted = input.value;
        const response = await chrome.runtime.sendMessage({ type: 'JOB_DATASOURCE_CORRECT', key: record.key, answer: submitted });
        if (!response?.ok) throw new Error(response?.error || 'Could not save the correction.');
        if (correctionDrafts.get(record.key) === submitted) correctionDrafts.delete(record.key);
        if (response.datasource) updateDatasourceSummary(response.datasource);
        setStatus('Correction saved. Previous values remain in history.');
      } catch (error) { setStatus(error.message, 'error'); }
      finally { button.disabled = close.disabled = false; }
    });
    close.addEventListener('click', async () => {
      button.disabled = close.disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({ type: 'JOB_DATASOURCE_DISMISS_CHANGE', key: record.key });
        if (!response?.ok) throw new Error(response?.error || 'Could not close the notification.');
        correctionDrafts.delete(record.key);
        if (response.datasource) updateDatasourceSummary(response.datasource);
        setStatus('Notification closed. The saved answer was not changed.');
      } catch (error) { setStatus(error.message, 'error'); }
      finally { button.disabled = close.disabled = false; }
    });
    correction.append(input, button, close);
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
  if (origin.inlineSessionId) return [draftKey(origin, origin.fieldId), kind, suffix].join(':');
  return [origin.applicationId || '', origin.pageSignature || '', origin.fieldId || '', kind, suffix].join(':');
}

function answerWorkspace(item, displayLabel, responseHandler = response => renderRun(response.run)) {
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
  textarea.readOnly = Boolean(state.answer.trim() && item.suggestion && !state.editing);
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
  const generate = document.createElement('button');
  generate.type = 'button';
  generate.dataset.generateSuggestions = 'true';
  generate.textContent = 'Generate AI answer';
  const feedback = document.createElement('p');
  feedback.className = 'result-detail';
  feedback.dataset.draftStatus = 'true';
  feedback.setAttribute('role', 'status');
  const send = document.createElement('button');
  send.type = 'button';
  send.dataset.sendAnswer = 'true';
  send.textContent = 'Send to form';
  send.className = 'answer-send';

  const promptRow = document.createElement('div');
  promptRow.className = 'rewrite-prompt-row';
  promptRow.hidden = !state.promptOpen;
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
    textarea.readOnly = Boolean(state.answer.trim() && item.suggestion && !state.editing);
    textarea.disabled = pending && !origin.inlineSessionId;
    prompt.disabled = pending;
    edit.disabled = pending || !state.answer.trim();
    rewrite.disabled = pending || !state.answer.trim();
    submitRewrite.disabled = pending || !state.answer.trim() || !prompt.value.trim();
    send.disabled = pending || !hasAnswer;
    generate.disabled = pending;
    generate.textContent = state.pending === 'generate' ? 'Generating…' : 'Generate AI answer';
    submitRewrite.textContent = state.pending === 'rewrite' ? 'Rewriting…' : 'Rewrite draft';
    workspace.setAttribute('aria-busy', String(pending));
    feedback.textContent = state.feedback || 'Generate from saved answers, or write a draft. Review before sending.';
  };
  // A storage refresh can replace this editor before an AI request returns.
  // Always refresh the current editor, not the detached request-time nodes.
  state.refresh = () => {
    textarea.value = state.answer;
    updateControls();
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
    state.promptOpen = true;
    promptRow.hidden = false;
    prompt.focus();
  });
  prompt.addEventListener('input', () => {
    state.rewriteInstruction = prompt.value;
    updateControls();
  });
  submitRewrite.addEventListener('click', async () => {
    const instruction = prompt.value.trim();
    if (state.pending || !instruction || !state.answer.trim()) return;
    const requestRevision = state.revision;
    const requestDraft = state.answer;
    state.pending = 'rewrite';
    state.feedback = 'Rewriting your draft…';
    updateControls();
    try {
      const response = await sendFieldAction('JOB_RUN_REWRITE_ANSWER', origin, {
        fieldId: origin.fieldId, draft: requestDraft, sourceKey: state.sourceKey, sourceKeys: state.sourceKeys,
        question: displayLabel, instruction });
      if (!response?.ok || typeof response.answer !== 'string') throw new Error(response?.error || 'Could not rewrite the answer.');
      if (state.revision !== requestRevision) {
        state.feedback = 'Draft changed while the rewrite was running. Your latest edit was kept.';
        setStatus(state.feedback);
        return;
      }
      updateDraftAnswer(state, response.answer);
      state.editing = true;
      textarea.value = state.answer;
      state.pending = null;
      if (origin.inlineSessionId) responseHandler(response);
      state.feedback = 'Draft rewritten. Review or edit it before sending it to the form.';
      setStatus(state.feedback);
    } catch (error) { state.feedback = error.message; setStatus(error.message, 'error'); }
    finally {
      if (state.pending === 'rewrite') state.pending = null;
      state.refresh();
    }
  });
  generate.addEventListener('click', async () => {
    if (state.pending) return;
    state.jobDescription = String(workspace.parentElement?.querySelector('[data-job-description]')?.value ?? state.jobDescription);
    const actionRevision = runRevision;
    const requestRevision = state.revision;
    state.pending = 'generate';
    state.feedback = 'Generating from your saved answers and this application…';
    updateControls();
    try {
      const response = await sendFieldAction('JOB_RUN_GENERATE_SUGGESTIONS', origin, { jobDescription: state.jobDescription.trim() });
      if (!response?.ok || (origin.inlineSessionId ? !response.inlineSession : !response.run)) throw new Error(response?.error || 'Could not generate an answer. Try again.');
      if (!origin.inlineSessionId && !canRenderActionResponse(response.run, actionRevision)) throw new Error('The page changed while suggestions were prepared. Check the page again.');
      const generated = origin.inlineSessionId
        ? response.inlineSession.generatedSuggestions?.[origin.fieldId]
        : response.run.generatedSuggestions?.[origin.fieldId] || [...(response.run.actionRequired || []), ...(response.run.optionalUnresolved || [])].find(field => field.fieldId === origin.fieldId)?.generatedSuggestion;
      if (state.revision === requestRevision && !state.answer.trim() && generated?.suggestions?.[0]?.answer) {
        updateDraftAnswer(state, generated.suggestions[0].answer);
        state.sourceKey = null; state.sourceKeys = []; state.candidateKind = null;
        state.editing = true;
      }
      state.pending = null;
      state.feedback = generated?.missingContext || 'AI answers are ready. Review or rewrite before sending.';
      responseHandler(response);
      setStatus(state.feedback);
    } catch (error) { state.feedback = error.message; setStatus(error.message, 'error'); }
    finally { state.pending = null; state.refresh(); }
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
      const response = await sendFieldAction(type, origin, { fieldId: origin.fieldId, answer,
        ...(candidateBacked ? {
          ...(state.sourceKey ? { sourceKey: state.sourceKey } : {}),
          ...(state.sourceKeys.length ? { sourceKeys: state.sourceKeys } : {}),
          ...(state.candidateKind ? { candidateKind: state.candidateKind } : {}),
        } : {}) });
      if (!response?.ok) throw new Error(response?.error || 'Could not send the answer to the form.');
      if (origin.inlineSessionId ? response.inlineSession?.sessionId !== origin.inlineSessionId : !response.run) throw new Error('Could not confirm the updated application state. Your draft was kept.');
      if (state.revision === requestRevision) clearDraft(origin, origin.fieldId);
      state.pending = null;
      responseHandler(response);
      if (state.revision !== requestRevision) {
        setStatus('The form received the earlier draft. Your newer edit was kept.');
      } else {
        setStatus('Answer applied and verified. Submission remains manual.');
      }
    } catch (error) { setStatus(error.message, 'error'); }
    finally {
      if (state.pending === 'apply') state.pending = null;
      state.refresh();
    }
  };
  send.addEventListener('click', applyAnswer);
  controls.append(generate, edit, rewrite, send);
  workspace.append(workspaceLabel, textarea, controls, promptRow, feedback);
  updateControls();
  return { workspace, state, origin, updateControls, applyAnswer };
}

function itemRow(item, { focus = false, detail = '', responseHandler = response => renderRun(response.run) } = {}) {
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
  if (displayLabel.length > 80) {
    label.classList.add('collapsed');
    const expand = document.createElement('button');
    expand.type = 'button';
    expand.textContent = 'Show full question';
    expand.setAttribute('aria-expanded', 'false');
    expand.addEventListener('click', () => {
      const collapsed = label.classList.toggle('collapsed');
      expand.setAttribute('aria-expanded', String(!collapsed));
      expand.textContent = collapsed ? 'Show full question' : 'Show less';
    });
    label.after(expand);
  }
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
    if (origin.inlineSessionId) button.addEventListener('click', async () => {
      try {
        const response = await sendFieldAction('JOB_RUN_FOCUS_FIELD', origin);
        if (!response?.ok) throw new Error(response?.error || 'Could not show this field on the page.');
        setStatus('Showing the matching field on the application page.');
      } catch (error) { setStatus(error.message, 'error'); }
    });
    content.append(button);
  }
  const workspace = focus && item.fieldId && (!onlyOpaqueSuggestions || hasReadableGeneratedDraft)
    ? answerWorkspace(item, displayLabel, responseHandler)
    : null;
  if (workspace) content.append(workspace.workspace);
  if (workspace) {
    const search = document.createElement('div');
    search.className = 'answer-search';
    const query = document.createElement('input');
    query.dataset.searchQuery = 'true';
    query.placeholder = 'Search saved answers';
    query.setAttribute('aria-label', 'Search previous answers');
    query.maxLength = 200;
    query.value = workspace.state.searchQuery;
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.searchAnswers = 'true'; button.textContent = 'Search';
    const semanticButton = document.createElement('button');
    semanticButton.type = 'button'; semanticButton.dataset.findSavedAnswer = 'true'; semanticButton.textContent = 'Find saved answer';
    const results = document.createElement('div');
    results.setAttribute('role', 'status');
    const showCandidates = (candidates, emptyText, complete = false) => {
      results.replaceChildren();
      for (const candidate of candidates || []) {
        if (isOpaqueIdentifier(candidate.answer)) continue;
        const choice = document.createElement('button'); choice.type = 'button'; choice.dataset.searchResult = 'true';
        choice.textContent = `${candidate.sourceQuestion || 'Saved answer'} — ${complete || candidate.answer.length <= 160 ? candidate.answer : `${candidate.answer.slice(0, 160)}…`}`;
        choice.addEventListener('click', () => {
          updateDraftAnswer(workspace.state, candidate.answer); workspace.state.sourceKey = candidate.sourceKey || null;
          workspace.state.sourceKeys = candidate.sourceKeys || (candidate.sourceKey ? [candidate.sourceKey] : []); workspace.state.candidateKind = candidate.kind || null;
          workspace.state.editing = true; workspace.workspace.querySelector('[data-answer-draft]').value = candidate.answer; workspace.updateControls();
        });
        results.append(choice);
      }
      if (!results.children.length) results.textContent = emptyText;
    };
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      const submittedQuery = workspace.state.searchQuery.trim();
      button.disabled = true;
      query.disabled = true;
      results.replaceChildren();
      if (origin.inlineSessionId) workspace.state.pending = 'search';
      try {
        const response = await sendFieldAction('JOB_RUN_SEARCH_ANSWERS', origin, { fieldId: origin.fieldId, query: submittedQuery });
        if (!search.isConnected || workspace.state.searchQuery.trim() !== submittedQuery) return;
        if (!response?.ok) throw new Error(response?.error || 'Could not search saved answers.');
        if (origin.inlineSessionId) responseHandler(response, {preserveContent: true});
        showCandidates(response.candidates, 'No saved answers found.');
      } catch (error) { if (search.isConnected) setStatus(error.message, 'error'); } finally {
        if (workspace.state.pending === 'search') workspace.state.pending = null;
        button.disabled = false;
        query.disabled = false;
        workspace.updateControls();
      }
    });
    semanticButton.addEventListener('click', async () => {
      if (semanticButton.disabled) return;
      semanticButton.disabled = true; results.textContent = 'Searching saved answers…';
      if (origin.inlineSessionId) workspace.state.pending = 'search';
      try {
        const response = await sendFieldAction('JOB_RUN_SEMANTIC_SEARCH', origin, {fieldId:origin.fieldId,retry:semanticButton.dataset.retry==='true'});
        if (!search.isConnected) return;
        if (!response?.ok) throw new Error(response?.error || 'Couldn’t search saved answers—try again.');
        if (origin.inlineSessionId) responseHandler(response, {preserveContent: true});
        if (response.semanticStatus === 'matched') {
          semanticButton.dataset.retry = 'false'; semanticButton.textContent = 'Find saved answer';
          showCandidates(response.candidates, 'No clear match.', true);
        } else if (response.semanticStatus === 'none' || response.semanticStatus === 'skipped') {
          semanticButton.dataset.retry = 'false'; semanticButton.textContent = 'Find saved answer'; results.textContent = 'No clear match.';
        } else {
          semanticButton.dataset.retry = 'true'; semanticButton.textContent = 'Try saved-answer search again'; results.textContent = 'Couldn’t search saved answers—try again.';
        }
      } catch (error) {
        semanticButton.dataset.retry = 'true'; semanticButton.textContent = 'Try saved-answer search again';
        if (search.isConnected) results.textContent = error.message;
      } finally {
        if (workspace.state.pending === 'search') workspace.state.pending = null;
        semanticButton.disabled = false;
        workspace.updateControls();
      }
    });
    query.addEventListener('input', () => { workspace.state.searchQuery = query.value; results.replaceChildren(); });
    search.append(semanticButton, query, button, results);
    content.insertBefore(search, workspace.workspace);
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
      editCandidate.textContent = 'Edit and use';
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
      if (!origin.inlineSessionId && candidate.kind !== 'draft' && candidate.kind !== 'planner' && sourceKeys.length === 1) {
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
  if (!currentSite.supported || currentSite.disabled) {
    elements.primaryAction.hidden = true;
    elements.fillPage.hidden = true;
    elements.secondaryActions.hidden = true;
    elements.saveAnswers.hidden = true;
    elements.saveHint.hidden = true;
    elements.retryAi.hidden = true;
    elements.employmentChoices.replaceChildren();
    return;
  }
  const status = run?.status;
  const hasRun = Boolean(run);
  const missingDestination = run?.frame === null;
  const selectForm = ['ambiguous_form', 'selecting_form'].includes(run?.waitingFor);
  elements.primaryAction.disabled = busy || status === 'running';
  for (const button of [elements.checkPage, elements.fillPage, elements.advancePage, elements.saveAnswers]) {
    button.disabled = busy || status === 'running';
  }
  elements.primaryAction.hidden = false;
  elements.fillPage.hidden = !['waiting_user', 'page_ready', 'ready_for_user_submit', 'answers_saved'].includes(status) || run?.waitingFor === 'page_changed' || selectForm;
  elements.checkPage.hidden = !['waiting_user', 'page_ready'].includes(status);
  // Saving stays visible independently of the application’s next step.
  elements.advancePage.hidden = true;
  elements.saveAnswers.hidden = !['waiting_user', 'page_ready', 'ready_for_user_submit', 'answers_saved'].includes(status);
  elements.saveAnswers.textContent = saving ? 'Saving…' : 'Save answers for future forms';
  elements.saveHint.hidden = elements.saveAnswers.hidden;
  elements.saveHint.textContent = missingDestination
    ? 'Find or select your application form before saving its answers.'
    : 'Save current answers without submitting the application.';
  elements.saveAnswers.setAttribute('aria-busy', String(saving));
  elements.saveAnswers.disabled ||= missingDestination;
  elements.checkPage.textContent = missingDestination ? 'Retry scan' : 'Check again';
  elements.secondaryActions.hidden = !hasRun || (elements.checkPage.hidden && elements.advancePage.hidden);
  if (!hasRun) {
    elements.retryAi.hidden = true;
    elements.primaryAction.textContent = 'Fill this form';
    return;
  }
  if (status === 'running') elements.primaryAction.textContent = 'Filling this page…';
  else if (status === 'waiting_user') elements.primaryAction.textContent = run.waitingFor === 'page_changed' ? 'Fill this page' : selectForm ? 'Select form' : missingDestination ? 'Retry scan' : (run.actionRequired || run.unresolved || [])[0]?.fieldId ? 'Review needed answers' : 'Check again';
  else if (status === 'page_ready') elements.primaryAction.textContent = 'Continue to next page';
  else if (['ready_for_user_submit', 'answers_saved'].includes(status)) elements.primaryAction.textContent = 'Review on site';
  else elements.primaryAction.textContent = 'Fill this form';
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
  if (!currentSite.supported || currentSite.disabled) run = null;
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
    elements.runTitle.textContent = !currentSite.supported ? 'Open an application' : currentSite.disabled ? 'Autofill is paused' : 'Ready to fill this form';
    elements.runSummary.textContent = !currentSite.supported ? 'Switch to a job application to get started.' : currentSite.disabled ? 'Re-enable this site using the site access menu above.' : 'Press Fill this form to enable autofill for this application.';
    elements.runState.textContent = !currentSite.supported ? 'Unavailable' : currentSite.disabled ? 'Paused' : 'Ready';
    elements.runState.className = 'pill neutral';
    elements.runHint.textContent = 'Review each page before continuing.';
    elements.runHint.hidden = !currentSite.supported || currentSite.disabled;
    elements.actionRequiredCard.hidden = true;
    elements.reviewCard.hidden = true;
    elements.optionalCount.textContent = '0';
    elements.auditCount.textContent = '0';
    elements.optionalDetails.hidden = true;
    elements.auditDetails.hidden = true;
    renderList(elements.optionalList, [], { emptyLabel: 'No optional fields', emptyDetail: 'Optional questions will appear here when unanswered.' });
    renderList(elements.auditList, [], { emptyLabel: 'No captured values', emptyDetail: 'Filled values will appear here after a page check.' });
    setActionVisibility(null);
    setStatus(currentSite.disabled ? 'Paused on this site.' : !currentSite.supported ? 'Waiting for an application page.' : 'Ready.');
    restorePanelState(panelState);
    return;
  }

  const actionRequired = run.actionRequired || run.unresolved || [];
  const optionalUnresolved = run.optionalUnresolved || [];
  const reviewRequired = run.reviewRequired || [];
  const audit = run.audit || [];
  elements.runHint.hidden = false;
  elements.runTitle.textContent = run.status === 'running' ? 'Filling this page…'
    : run.frame === null ? 'Let’s find your form'
    : run.status === 'waiting_user' ? (actionRequired.length ? `${actionRequired.length} item${actionRequired.length === 1 ? '' : 's'} need${actionRequired.length === 1 ? 's' : ''} your attention` : 'Check the application page')
    : run.status === 'answers_saved' ? 'Your answers are saved'
    : ['page_ready', 'ready_for_user_submit'].includes(run.status) ? 'This page is filled'
    : 'Current application';
  elements.runSummary.textContent = run.frame === null ? 'Choose or rescan the application form.'
    : `${audit.length} filled value${audit.length === 1 ? '' : 's'}${reviewRequired.length ? ` · ${reviewRequired.length} to review` : ''}${actionRequired.length ? ` · ${actionRequired.length} need answers` : ''}${run.frame?.interpretationMode ? ` · AI ${run.frame.interpretationMode} context` : ''}`;
  const failedAi = Object.values(run.aiOperations || {}).some((operation) => ['failed', 'interrupted'].includes(operation?.status || operation));
  elements.retryAi.hidden = !failedAi && !run.llmError;
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
  elements.runState.textContent = (run.status === 'running' && progressLabels[run.progress]) || STATUS_LABELS[run.status] || run.status;
  const accentStatuses = ['waiting_user', 'page_ready', 'ready_for_user_submit', 'answers_saved'];
  elements.runState.className = `pill${accentStatuses.includes(run.status) ? '' : ' neutral'}`;
  setActionVisibility(run);

  elements.actionRequiredCount.textContent = String(actionRequired.length);
  // Reveal field actions on the first result/new page, but respect a user's
  // collapse choice during subsequent background updates of the same page.
  if (actionRequired.length && (elements.actionRequiredCard.hidden || previousOrigin !== nextOrigin)) {
    panelState.openDetails[elements.actionRequiredCard.id] = true;
  }
  elements.actionRequiredCard.hidden = actionRequired.length === 0;
  renderList(elements.actionRequiredList, actionRequired, { focus: run.frame !== null, emptyDetail: 'No blockers on this page.' });

  elements.reviewCount.textContent = String(reviewRequired.length);
  elements.reviewCard.hidden = reviewRequired.length === 0 && !['ready_for_user_submit', 'answers_saved'].includes(run.status);
  renderList(elements.reviewList, reviewRequired, { emptyLabel: 'No additional review items', emptyDetail: 'All currently filled values are low-risk and validated.' });
  elements.submitInstructions.hidden = !['ready_for_user_submit', 'answers_saved'].includes(run.status);

  elements.optionalCount.textContent = String(optionalUnresolved.length);
  elements.optionalDetails.hidden = optionalUnresolved.length === 0;
  renderList(elements.optionalList, optionalUnresolved, { focus: run.frame !== null, emptyLabel: 'No optional unanswered fields', emptyDetail: 'Optional questions are complete or not present on this page.' });

  elements.auditCount.textContent = String(audit.length);
  elements.auditDetails.hidden = audit.length === 0;
  renderList(elements.auditList, audit, { detail: '' });

  if (run.status === 'waiting_user') {
    const waitingLabel = String(run.waitingLabel || '').trim();
    const visibleWaitingLabel = waitingLabel && !isOpaqueIdentifier(waitingLabel) ? waitingLabel : '';
    elements.runHint.textContent = run.waitingFor === 'page_changed' ? 'The application page changed. Fill this page using your saved answers, then review it before continuing.' : run.frame === null ? (run.actionRequired?.[0]?.reason || 'Retry the scan to find the application form.') : visibleWaitingLabel
      ? `Complete “${visibleWaitingLabel}” on the application page, then click Check again.`
      : 'Complete the highlighted field or handle the manual step, then click Check again.';
    setStatus(run.llmError ? 'Couldn’t prepare AI answers. Try Retry AI.' : 'Action is required on the application page.', run.llmError ? 'error' : 'ok', run.llmError || '');
  } else if (run.status === 'page_ready') {
    elements.runHint.textContent = 'This page is filled and validated. Review it, then continue when you are ready.';
    setStatus(`Page ${run.pageNumber || 1} is ready for your approval.`);
  } else if (run.status === 'ready_for_user_submit') {
    elements.runHint.textContent = 'Review on the site, then submit there. You can save your answers for future forms at any time.';
    setStatus('Final page is ready. Submission stays manual; final values are captured automatically.');
  } else if (run.status === 'answers_saved') {
    elements.runHint.textContent = 'Saved locally. Final values are captured automatically when you submit on the site.';
    setStatus('Answers saved. Submission remains manual.');
  } else if (run.status === 'running') {
    elements.runHint.textContent = elements.autoAdvance.checked
      ? `Filling page ${run.pageNumber || 1}. Completed pages will advance automatically; final submission stays manual.`
      : `Filling page ${run.pageNumber || 1}. The panel will stop for your review before navigation.`;
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
    if (currentRun.waitingFor === 'page_changed') return sendRunAction('JOB_RUN_CHECK_PAGE');
    if (['ambiguous_form', 'selecting_form'].includes(currentRun.waitingFor)) return sendRunAction('JOB_RUN_SELECT_FORM');
    if (currentRun.frame === null) return sendRunAction('JOB_RUN_CHECK_PAGE');
    if (!elements.actionRequiredCard.hidden) {
      elements.actionRequiredCard.open = true;
      elements.actionRequiredCard.querySelector('summary').focus();
    }
    const first = (currentRun.actionRequired || currentRun.unresolved || [])[0];
    if (first?.fieldId) return focusField(first.fieldId);
    return sendRunAction('JOB_RUN_VALIDATE_PAGE');
  }
  if (['ready_for_user_submit', 'answers_saved'].includes(currentRun?.status)) {
    const detail = currentRun.reviewRequired?.length ? elements.reviewCard : elements.auditDetails;
    if (!detail.hidden) {
      detail.open = true;
      detail.querySelector('summary').focus();
    }
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
  await refreshSiteState();
  const stored = await chrome.storage.local.get({ answerRecords: [], openaiApiKey: '', fireworksApiKey: '', typesafeApiKey: '', typesafeEnabled: false, aiProvider: '', aiModel: '', openaiModel: 'gpt-5.6-terra', includeFormScreenshot: true, autoAdvancePages: false, phoenixTracing: true });
  const provider = stored.aiProvider === 'openai' || stored.aiProvider === 'fireworks'
    ? stored.aiProvider
    : (stored.openaiApiKey ? 'openai' : 'fireworks');
  const defaultModel = provider === 'fireworks' ? 'accounts/fireworks/models/glm-5p3-flash' : 'gpt-5.6-terra';
  elements.provider.value = provider;
  elements.provider.selectedIndex = provider === 'openai' ? 1 : 0;
  elements.fireworksApiKey.value = stored.fireworksApiKey || '';
  elements.openaiApiKey.value = stored.openaiApiKey || '';
  elements.typesafeApiKey.value = stored.typesafeApiKey || '';
  elements.typesafeEnabled.checked = Boolean(stored.typesafeEnabled);
  elements.apiModel.value = stored.aiModel || (provider === 'openai' ? stored.openaiModel : '') || defaultModel;
  elements.includeFormScreenshot.checked = stored.includeFormScreenshot !== false;
  elements.phoenixTracing.checked = stored.phoenixTracing !== false;
  await refreshPhoenixStatus();
  elements.autoAdvance.checked = Boolean(stored.autoAdvancePages);
  updateDatasourceSummary({ answerCount: stored.answerRecords.length });
  const datasourceResponse = await chrome.runtime.sendMessage({ type: 'JOB_DATASOURCE_STATE' });
  if (datasourceResponse?.ok) updateDatasourceSummary(datasourceResponse.datasource);
  if (activeTabId) {
    const response = await chrome.runtime.sendMessage({ type: 'JOB_RUN_STATE', tabId: activeTabId });
    if (response?.ok) renderRun(response.run);
  } else renderRun(null);
  await loadInlineField();
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
  if (currentRun?.status === 'running') renderRun(currentRun);
  setStatus(elements.autoAdvance.checked ? 'Automatic page advance enabled.' : 'Automatic page advance disabled.');
}

async function saveScreenshotSetting() {
  await chrome.storage.local.set({ includeFormScreenshot: Boolean(elements.includeFormScreenshot.checked) });
  setStatus(elements.includeFormScreenshot.checked ? 'Visual form context enabled.' : 'Using text form context only.');
}

async function saveTypeSafeSetting() {
  await chrome.storage.local.set({ typesafeEnabled: Boolean(elements.typesafeEnabled.checked) });
  setStatus(elements.typesafeEnabled.checked ? 'TypeSafe saved-answer search enabled.' : 'TypeSafe saved-answer search disabled.');
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

for (const [input, key, label] of [[elements.fireworksApiKey, 'fireworksApiKey', 'Fireworks'], [elements.openaiApiKey, 'openaiApiKey', 'OpenAI'], [elements.typesafeApiKey, 'typesafeApiKey', 'TypeSafe']]) {
  input.addEventListener('change', () => saveApiKey(input, key, label));
  input.addEventListener('blur', () => saveApiKey(input, key, label));
  input.addEventListener('input', () => saveApiKey(input, key, label));
}
elements.provider.addEventListener('change', saveProvider);
elements.apiModel.addEventListener('change', saveModel);
elements.apiModel.addEventListener('blur', saveModel);
elements.autoAdvance.addEventListener('change', saveSettings);
elements.includeFormScreenshot.addEventListener('change', saveScreenshotSetting);
elements.typesafeEnabled.addEventListener('change', saveTypeSafeSetting);
elements.phoenixTracing.addEventListener('change', async () => {
  await chrome.storage.local.set({ phoenixTracing: elements.phoenixTracing.checked });
  setStatus(elements.phoenixTracing.checked ? 'Local Phoenix tracing enabled.' : 'AI tracing disabled.');
  await refreshPhoenixStatus();
});
for (const [field, key] of [[elements.employerName, 'employerName'], [elements.relatedDefault, 'relatedToHiringCompany'], [elements.knownDefault, 'knownAtHiringCompany'], [elements.phoneDeviceDefault, 'phoneDeviceType']]) field.addEventListener('change', () => saveProfile(key));
elements.exportDatasource.addEventListener('click', exportDatasource);
elements.importDatasourceButton.addEventListener('click', () => elements.importDatasource.click());
elements.importDatasource.addEventListener('change', () => importDatasource(elements.importDatasource.files?.[0]));
elements.siteToggle.addEventListener('click', toggleSite);
elements.disabledSiteList.addEventListener('click', (event) => {
  const button = event.target.closest?.('[data-disabled-hostname]');
  if (button?.dataset.disabledHostname) removeDisabledSite(button.dataset.disabledHostname);
});
elements.primaryAction.addEventListener('click', runPrimaryAction);
byId('open-settings').addEventListener('click', () => {
  byId('settings-data').open = true;
  byId('settings-data').querySelector('summary').focus();
});
elements.fillPage.addEventListener('click', () => sendRunAction('JOB_RUN_CHECK_PAGE'));
elements.checkPage.addEventListener('click', () => sendRunAction('JOB_RUN_VALIDATE_PAGE'));
elements.closeInlineField.addEventListener('click', async () => {
  const session = currentInlineSession;
  if (!session) return;
  ++inlineLoadRevision;
  renderInlineField(null);
  try {
    const response = await chrome.runtime.sendMessage({type: 'JOB_INLINE_PANEL_STATE', tabId: session.tabId, frameId: session.frameId, inlineSessionId: session.sessionId, close: true});
    if (!response?.ok) throw new Error(response?.error || 'Could not close the selected field.');
  } catch (error) { setStatus(error.message, 'error'); }
});
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
  if (area === 'local' && changes.autoAdvancePages) {
    elements.autoAdvance.checked = Boolean(changes.autoAdvancePages.newValue);
    if (currentRun?.status === 'running') renderRun(currentRun);
  }
  if (area === 'local' && changes.phoenixTracing) elements.phoenixTracing.checked = changes.phoenixTracing.newValue !== false;
  if (area === 'local' && (changes.phoenixTraceQueue || changes.phoenixTraceStatus || changes.phoenixTracing)) refreshPhoenixStatus().catch(() => {});
  if (area === 'local' && changes.includeFormScreenshot) elements.includeFormScreenshot.checked = changes.includeFormScreenshot.newValue !== false;
  if (area === 'local' && changes.disabledHostnames) refreshSiteState().catch(error => setStatus(error.message, 'error'));
  if (area === 'session' && changes.applicationRun && activeTabId) renderRun(changes.applicationRun.newValue?.[String(activeTabId)] || null);
  if (area === 'session' && changes.inlineFieldSessions) loadInlineField().catch(error => setStatus(error.message, 'error'));
});
if (chrome.tabs?.onActivated?.addListener) {
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    setSaveFeedback();
    activeTabId = tabId;
    renderInlineField(null, {preserveDrafts: true});
    refresh().catch((error) => setStatus(error.message, 'error'));
  });
}

refresh().catch((error) => setStatus(error.message, 'error'));
