import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { URL as NodeUrl } from 'node:url';
import { JSDOM } from 'jsdom';

const root = new NodeUrl('../', import.meta.url);

const PAGE_MUTATION_MESSAGE_TYPES = new Set([
  'JOB_APP_APPLY',
  'JOB_RUN_APPLY_DRAFT',
  'JOB_RUN_APPROVE_SUGGESTION',
]);

function pageMutationMessages(messages) {
  return messages.filter(({ type }) => PAGE_MUTATION_MESSAGE_TYPES.has(type));
}

async function loadPanelHtml() {
  const html = await readFile(new NodeUrl('sidepanel.html', root), 'utf8');
  return html.replace(/<link rel="stylesheet"[^>]*>/, '').replace(/<script type="module" src="src\/sidepanel\.js"><\/script>/, '');
}

async function setupPanel({
  run = null,
  datasource = { answerCount: 3, coverMessageCount: 1 },
  localData = { openaiApiKey: 'sk-test', autoAdvancePages: false },
  applyDraftResponse = { ok: true, run },
  approveSuggestionResponse = { ok: true, run },
  rewriteResponse = { ok: true, answer: 'Rewritten answer.' },
  generateResponse = { ok: true, run },
  validateResponse = { ok: true, run }, retryAiResponse = { ok: true, run }, searchResponse = { ok: true, candidates: [], run }, selectEmploymentResponse = { ok: true, run },
} = {}) {
  const dom = new JSDOM(await loadPanelHtml(), {
    url: 'https://extension.local/sidepanel.html',
    pretendToBeVisual: true,
  });
  const sentMessages = [];
  const storageListeners = [];
  const createdUrls = [];
  const revokedUrls = [];
  const clickedDownloads = [];
  const copyCalls = [];
  const originalCreateElement = dom.window.document.createElement.bind(dom.window.document);

  dom.window.document.createElement = function createElement(tagName, options) {
    const element = originalCreateElement(tagName, options);
    if (String(tagName).toLowerCase() === 'a') {
      element.click = () => {
        clickedDownloads.push({ href: element.href, download: element.download });
      };
    }
    return element;
  };

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async (value) => copyCalls.push(value) }, configurable: true });
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLInputElement = dom.window.HTMLInputElement;
  globalThis.Event = dom.window.Event;
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.Blob = dom.window.Blob;
  globalThis.File = dom.window.File;
  globalThis.FileReader = dom.window.FileReader;
  globalThis.URL = {
    createObjectURL(blob) {
      createdUrls.push(blob);
      return `blob:mock-${createdUrls.length}`;
    },
    revokeObjectURL(url) {
      revokedUrls.push(url);
    },
  };

  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        sentMessages.push(message);
        if (message.type === 'JOB_RUN_STATE') return { ok: true, run };
        if (message.type === 'JOB_DATASOURCE_STATE') return { ok: true, datasource };
        if (message.type === 'JOB_RUN_START') return { ok: true, run: { ...run, status: 'running' } };
        if (message.type === 'JOB_RUN_CHECK_PAGE') return { ok: true, run: { ...run, status: 'waiting_user' } };
        if (message.type === 'JOB_RUN_ADVANCE_PAGE') return { ok: true, run: { ...run, status: 'running' } };
        if (message.type === 'JOB_RUN_SAVE_ANSWERS') return {
          ok: true,
          run: run?.status === 'ready_for_user_submit' ? { ...run, status: 'answers_saved' } : run,
          savedCount: 2,
        };
        if (message.type === 'JOB_RUN_FOCUS_FIELD') return { ok: true, run };
        if (message.type === 'JOB_RUN_APPLY_DRAFT') return typeof applyDraftResponse === 'function' ? applyDraftResponse(message) : applyDraftResponse;
        if (message.type === 'JOB_RUN_APPROVE_SUGGESTION') return typeof approveSuggestionResponse === 'function' ? approveSuggestionResponse(message) : approveSuggestionResponse;
        if (message.type === 'JOB_RUN_REWRITE_ANSWER') return typeof rewriteResponse === 'function' ? rewriteResponse(message) : rewriteResponse;
        if (message.type === 'JOB_RUN_GENERATE_SUGGESTIONS') return typeof generateResponse === 'function' ? generateResponse(message) : generateResponse;
        if (message.type === 'JOB_RUN_VALIDATE_PAGE') return validateResponse;
        if (message.type === 'JOB_RUN_RETRY_AI') return retryAiResponse;
        if (message.type === 'JOB_RUN_SEARCH_ANSWERS') return searchResponse;
        if (message.type === 'JOB_RUN_SELECT_EMPLOYMENT') return selectEmploymentResponse;
        if (message.type === 'JOB_DATASOURCE_EXPORT') return { ok: true, backup: '{"schemaVersion":1}' };
        if (message.type === 'JOB_DATASOURCE_IMPORT') return { ok: true, datasource };
        return { ok: true };
      },
    },
    tabs: {
      query: async () => [{ id: 7 }],
      onActivated: { addListener: () => {} },
    },
    storage: {
      local: {
        get: async (defaults) => ({ ...defaults, ...localData }),
        set: async (values) => Object.assign(localData, values),
      },
      onChanged: {
        addListener: (listener) => storageListeners.push(listener),
      },
    },
  };

  await import(`../src/sidepanel.js?test=${Date.now()}-${Math.random()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));

  return {
    dom,
    localData,
    sentMessages,
    storageListeners,
    createdUrls,
    revokedUrls,
    clickedDownloads,
    copyCalls,
    cleanup() {
      dom.window.close();
      delete globalThis.window;
      delete globalThis.document;
      delete globalThis.navigator;
      delete globalThis.HTMLElement;
      delete globalThis.HTMLInputElement;
      delete globalThis.Event;
      delete globalThis.CustomEvent;
      delete globalThis.Blob;
      delete globalThis.File;
      delete globalThis.FileReader;
      delete globalThis.URL;
      delete globalThis.chrome;
    },
  };
}

test('recommended saved answer applies through the guarded path in one click', async () => {
  const suggestion = { tabId: 7, frameId: 3, applicationId: 'run-one', pageSignature: 'page-one', field: { id: 'ml', handle: 'handle-one' }, candidates: [{ sourceKey: 'story', sourceQuestion: 'Saved project', answer: 'Synthetic model project narrative.', provenance: 'user', reason: 'Related ML evidence', kind: 'related' }] };
  const harness = await setupPanel({ run: { status: 'waiting_user', actionRequired: [{ fieldId: 'ml', label: 'ML experience', suggestion }], optionalUnresolved: [], reviewRequired: [], audit: [] } });
  try {
    const doc = harness.dom.window.document;
    assert.match(doc.querySelector('#action-required-list').textContent, /Saved project/);
    assert.match(doc.querySelector('#action-required-list').textContent, /Synthetic model project narrative/);
    const row = doc.querySelector('#action-required-list .result-item');
    assert.equal(row.querySelector('[data-choose-answer]').textContent, 'Use answer');
    row.querySelector('[data-choose-answer]').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const sent = harness.sentMessages.find(message => message.type === 'JOB_RUN_APPROVE_SUGGESTION');
    assert.equal(sent.tabId, 7); assert.equal(sent.frameId, 3); assert.equal(sent.handle, 'handle-one'); assert.equal(sent.sourceKey, 'story');
  } finally { harness.cleanup(); }
});

test('editing a saved recommendation opens a writable draft without applying it', async () => {
  const answer = 'I built and deployed reliable machine-learning systems in production. '.repeat(5).trim();
  const suggestion = {
    tabId: 7,
    frameId: 3,
    applicationId: 'run-one',
    pageSignature: 'page-one',
    field: { id: 'experience', handle: 'handle-one', label: 'Describe your ML experience', type: 'textarea' },
    candidates: [{ sourceKey: 'deployment_story', sourceQuestion: 'Model deployment project', answer, provenance: 'user', kind: 'related' }],
  };
  const harness = await setupPanel({ run: { status: 'waiting_user', actionRequired: [{ fieldId: 'experience', label: 'Describe your ML experience', suggestion }], optionalUnresolved: [], reviewRequired: [], audit: [] } });
  try {
    const row = harness.dom.window.document.querySelector('#action-required-list .result-item');
    const card = row.querySelector('.saved-evidence');
    assert.equal(card.open, false);
    assert.equal(card.querySelector('summary').textContent, 'Saved answer from Model deployment project');
    assert.equal(card.querySelector('[data-saved-answer-text]').textContent, answer);
    assert.equal(row.querySelectorAll('.answer-details').length, 0);
    card.open = true;
    row.querySelector('[data-edit-candidate]').click();
    assert.equal(row.querySelector('[data-answer-draft]').value, answer);
    assert.equal(row.querySelector('[data-answer-draft]').readOnly, false);
    assert.deepEqual(pageMutationMessages(harness.sentMessages), []);
  } finally { harness.cleanup(); }
});

test('saved answer feedback sends a per-question suppression and requires deletion confirmation', async () => {
  const suggestion = {
    tabId: 7,
    frameId: 3,
    applicationId: 'run-one',
    pageSignature: 'page-one',
    field: { id: 'experience', handle: 'handle-one', label: 'Describe your ML experience', type: 'textarea' },
    candidates: [{ sourceKey: 'deployment_story', sourceQuestion: 'Model deployment project', answer: 'I deployed production ML systems.', provenance: 'user', kind: 'related' }],
  };
  const harness = await setupPanel({ run: { status: 'waiting_user', actionRequired: [{ fieldId: 'experience', label: 'Describe your ML experience', suggestion }], optionalUnresolved: [], reviewRequired: [], audit: [] } });
  try {
    const row = harness.dom.window.document.querySelector('#action-required-list .result-item');
    row.querySelector('[data-dismiss-saved-answer]').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(harness.sentMessages.find(message => message.type === 'JOB_DATASOURCE_SUPPRESS_ANSWER'), {
      type: 'JOB_DATASOURCE_SUPPRESS_ANSWER', tabId: 7, fieldId: 'experience', sourceKey: 'deployment_story',
    });
    row.querySelector('[data-delete-saved-answer]').click();
    assert.ok(row.querySelector('[data-confirm-delete-saved-answer]'));
    row.querySelector('[data-confirm-delete-saved-answer]').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(harness.sentMessages.find(message => message.type === 'JOB_DATASOURCE_DELETE_ANSWER'), {
      type: 'JOB_DATASOURCE_DELETE_ANSWER', tabId: 7, fieldId: 'experience', sourceKey: 'deployment_story',
    });
  } finally { harness.cleanup(); }
});

test('panel hides opaque saved values without exposing an internal-ID control', async () => {
  const opaqueValue = '5ec015e5642301ec004c2eaa25504002';
  const suggestion = {
    tabId: 7,
    frameId: 3,
    applicationId: 'run-one',
    pageSignature: 'page-one',
    field: { id: 'phone_type', handle: 'handle-one' },
    candidates: [{ sourceKey: 'phone_type', sourceQuestion: 'Phone Device Type', answer: opaqueValue, provenance: 'user', kind: 'draft' }],
  };
  const run = {
    status: 'waiting_user',
    waitingLabel: 'Phone Device Type',
    actionRequired: [{ fieldId: 'phone_type', label: 'Phone Device Type', suggestion }],
    optionalUnresolved: [],
    reviewRequired: [],
    audit: [],
  };
  const harness = await setupPanel({ run });
  try {
    const list = harness.dom.window.document.querySelector('#action-required-list');
    assert.match(list.textContent, /choose a value for Phone Device Type on the application page/i);
    assert.equal(list.querySelector('[data-internal-id]'), null);
    assert.equal(list.querySelector('[data-internal-id-popover]'), null);
    assert.doesNotMatch(list.textContent, new RegExp(opaqueValue, 'i'));
    assert.equal([...list.querySelectorAll('button')].some((button) => /saved answer|edit and use|approve edited/i.test(button.textContent)), false);
  } finally { harness.cleanup(); }
});

test('panel orders named fields before generic notices and emphasizes each question', async () => {
  const run = {
    status: 'waiting_user',
    actionRequired: [
      { code: 'unsupported_widget', reason: 'Complete the unsupported or inaccessible widget manually' },
      { fieldId: 'second', label: 'Second question', pageNumber: 2, formOrder: 2, reason: 'No validated answer is available' },
      { fieldId: 'later', label: 'Later question', pageNumber: 1, formOrder: 2, reason: 'No validated answer is available' },
      { fieldId: 'first', label: 'First question', pageNumber: 1, formOrder: 0, reason: 'No validated answer is available' },
    ],
    optionalUnresolved: [{ fieldId: 'optional', label: 'Optional question', formOrder: 1, reason: 'No validated answer is available' }],
    reviewRequired: [{ fieldId: 'review', label: 'Review question', formOrder: 1, value: 'Review this', reason: 'Needs review' }],
    audit: [{ key: 'second', question: 'Second question', answer: 'Second answer', formOrder: 2 }, { key: 'first', question: 'First question', answer: 'First answer', formOrder: 0 }],
  };
  const harness = await setupPanel({ run });
  try {
    const doc = harness.dom.window.document;
    const actionItems = [...doc.querySelectorAll('#action-required-list .result-item')];
    assert.deepEqual(actionItems.map((item) => item.querySelector('.result-label').textContent), ['First question', 'Later question', 'Second question', 'Field']);
    assert.equal(actionItems[0].querySelector('.result-label').tagName, 'H3');
    assert.match(actionItems[0].textContent, /Enter or select an answer.*Check again/i);
    assert.deepEqual([...doc.querySelectorAll('#optional-list .result-item .result-label')].map((item) => item.textContent), ['Optional question']);
    assert.deepEqual([...doc.querySelectorAll('#review-list .result-item .result-label')].map((item) => item.textContent), ['Review question']);
    assert.deepEqual([...doc.querySelectorAll('#audit-list .result-item .result-label')].map((item) => item.textContent), ['First question', 'Second question']);
  } finally { harness.cleanup(); }
});

test('panel hides an opaque source question without an info button while keeping the saved answer usable', async () => {
  const internalQuestion = 'cards|d20089ff-f389-44ef-9398-eec15ba7b6a4[field1]';
  const suggestion = {
    tabId: 7,
    frameId: 3,
    applicationId: 'run-one',
    pageSignature: 'page-one',
    field: { id: 'ocr', handle: 'handle-one' },
    candidates: [{ sourceKey: 'ocr', sourceQuestion: internalQuestion, answer: 'Above 6 years experience in AI/ML Engineering', provenance: 'user', reason: 'Related saved evidence', kind: 'related' }],
  };
  const run = { status: 'waiting_user', waitingLabel: internalQuestion, actionRequired: [{ fieldId: 'ocr', label: 'AI OCR', formOrder: 0, suggestion }], optionalUnresolved: [], reviewRequired: [], audit: [] };
  const harness = await setupPanel({ run });
  try {
    const row = harness.dom.window.document.querySelector('#action-required-list .result-item');
    assert.doesNotMatch(harness.dom.window.document.querySelector('#run-hint').textContent, new RegExp(internalQuestion, 'i'));
    assert.equal(row.querySelector('.result-label').textContent, 'AI OCR');
    assert.equal(row.querySelector('.result-label').tagName, 'H3');
    assert.match(row.textContent, /Above 6 years experience/);
    assert.equal(row.querySelector('[data-internal-id]'), null);
    assert.equal(row.querySelector('[data-internal-id-popover]'), null);
    assert.doesNotMatch(row.textContent, new RegExp(internalQuestion, 'i'));
    assert.equal([...row.querySelectorAll('button')].some((button) => /Use this saved answer|Edit and use/.test(button.textContent)), false);
    assert.ok(row.querySelector('[data-choose-answer]'));
  } finally { harness.cleanup(); }
});

test('panel keeps opaque field labels and audit values out of the visible panel', async () => {
  const internalField = 'cards|d20089ff-f389-44ef-9398-eec15ba7b6a4[field2]';
  const internalAnswer = '5ec01e56e42301ec004c2eaa25504002';
  const run = {
    status: 'page_ready',
    actionRequired: [{ fieldId: internalField, label: internalField, reason: 'Complete this field manually' }],
    optionalUnresolved: [],
    reviewRequired: [],
    audit: [{ key: internalField, question: internalField, answer: internalAnswer, sensitivity: 'safe' }],
  };
  const harness = await setupPanel({ run });
  try {
    const doc = harness.dom.window.document;
    const actionRow = doc.querySelector('#action-required-list .result-item');
    assert.equal(actionRow.querySelector('.result-label').firstChild.textContent, 'Form question');
    assert.equal(actionRow.querySelector('[data-internal-id-popover]'), null);
    const auditRow = doc.querySelector('#audit-list .result-item');
    assert.doesNotMatch(auditRow.textContent, /internal ID/i);
    assert.equal(auditRow.querySelector('[data-internal-id-popover]'), null);
    assert.doesNotMatch(auditRow.textContent, new RegExp(internalAnswer, 'i'));
  } finally { harness.cleanup(); }
});

test('panel renders grouped sections, collapsed details, and status-specific actions', async () => {
  const run = {
    status: 'page_ready',
    pageNumber: 2,
    actionRequired: [{ fieldId: 'work_auth', label: 'Work authorization', reason: 'No validated answer is available' }],
    optionalUnresolved: [{ fieldId: 'portfolio', label: 'Portfolio', reason: 'No validated answer is available' }],
    reviewRequired: [{
      fieldId: 'summary',
      label: 'Professional summary',
      value: 'A'.repeat(260),
      sensitivity: 'review',
      confidence: 'medium',
      reason: 'Long-form answer',
    }],
    audit: [{ key: 'full_name', question: 'Full name', answer: 'Nithin', sensitivity: 'safe' }],
  };
  const harness = await setupPanel({ run });

  try {
    const { document } = harness.dom.window;
    assert.equal(document.querySelector('#run-state').textContent.trim(), 'Page ready');
    assert.equal(document.querySelector('#primary-action').textContent.trim(), 'Continue to next page');
    assert.equal(document.querySelector('#secondary-actions').hidden, false);
    assert.equal(document.querySelector('#check-page').hidden, false);
    assert.equal(document.querySelector('#advance-page').hidden, true);
    assert.equal(document.querySelector('#save-answers').hidden, false);
    assert.equal(document.querySelector('#action-required-card').hidden, false);
    assert.equal(document.querySelector('#review-card').hidden, false);
    assert.equal(document.querySelector('#optional-details').open, false);
    assert.equal(document.querySelector('#audit-details').open, false);
    assert.equal(document.querySelector('#action-required-count').textContent.trim(), '1');
    assert.equal(document.querySelector('#review-count').textContent.trim(), '1');
    assert.equal(document.querySelector('#optional-count').textContent.trim(), '1');
    assert.equal(document.querySelector('#audit-count').textContent.trim(), '1');
    assert.match(document.querySelector('#review-list').textContent, /Professional summary/);
    assert.match(document.querySelector('#review-list summary').textContent, /show full/i);
    assert.equal(document.querySelector('#submit-instructions').hidden, true);
  } finally {
    harness.cleanup();
  }
});

test('panel uses the accent status treatment when user action is required', async () => {
  const harness = await setupPanel({ run: { status: 'waiting_user', pageNumber: 1, actionRequired: [], optionalUnresolved: [], reviewRequired: [], audit: [] } });
  try {
    const state = harness.dom.window.document.querySelector('#run-state');
    assert.equal(state.className, 'pill');
    assert.equal(state.classList.contains('neutral'), false);
  } finally { harness.cleanup(); }
});

test('panel persists settings, focuses blockers, and saves answers without any submit control', async () => {
  const run = {
    status: 'ready_for_user_submit',
    pageNumber: 3,
    actionRequired: [{ fieldId: 'work_auth', label: 'Work authorization', reason: 'No validated answer is available' }],
    optionalUnresolved: [],
    reviewRequired: [],
    audit: [],
  };
  const harness = await setupPanel({ run, localData: { openaiApiKey: '', autoAdvancePages: false } });

  try {
    const { document, Event } = harness.dom.window;
    const checkbox = document.querySelector('#auto-advance-pages');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    assert.equal(harness.localData.autoAdvancePages, true);

    const apiKey = document.querySelector('#openai-api-key');
    apiKey.value = 'sk-live';
    apiKey.dispatchEvent(new Event('input', { bubbles: true }));
    assert.equal(harness.localData.openaiApiKey, 'sk-live');

    document.querySelector('#action-required-list button').click();
    document.querySelector('#save-answers').click();
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(harness.sentMessages.some((message) => message.type === 'JOB_RUN_FOCUS_FIELD' && message.fieldId === 'work_auth'), true);
    assert.equal(harness.sentMessages.some((message) => message.type === 'JOB_RUN_SAVE_ANSWERS'), true);
    assert.equal(document.querySelector('#run-state').textContent.trim(), 'Answers saved');
    assert.equal(document.querySelector('#submit-instructions').hidden, false);
    assert.match(document.querySelector('#run-hint').textContent, /captured automatically when you submit/i);
    assert.doesNotMatch(document.body.textContent, /Confirm & submit/i);
  } finally {
    harness.cleanup();
  }
});

test('panel defaults to Fireworks and persists its key and selected model', async () => {
  const harness = await setupPanel({ localData: { fireworksApiKey: '', aiProvider: '', aiModel: '', openaiApiKey: '', autoAdvancePages: false } });
  try {
    const { document, Event } = harness.dom.window;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(document.querySelector('#ai-provider').options[0].value, 'fireworks');
    const provider = document.querySelector('#ai-provider');
    provider.value = 'fireworks';
    provider.dispatchEvent(new Event('change', { bubbles: true }));
    const key = document.querySelector('#fireworks-api-key');
    key.value = 'fw-live';
    key.dispatchEvent(new Event('input', { bubbles: true }));
    const model = document.querySelector('#ai-model');
    model.value = 'accounts/fireworks/models/other-model';
    model.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(harness.localData.fireworksApiKey, 'fw-live');
    assert.equal(harness.localData.aiProvider, 'fireworks');
    assert.equal(harness.localData.aiModel, 'accounts/fireworks/models/other-model');
  } finally {
    harness.cleanup();
  }
});

test('panel exposes and saves the phone device profile default', async () => {
  const harness = await setupPanel({
    datasource: { answerCount: 3, coverMessageCount: 1, profile: { employment: [{ company: 'Example' }], defaults: { relatedToHiringCompany: 'No', knownAtHiringCompany: 'No', phoneDeviceType: 'Mobile' } } },
  });
  try {
    const select = harness.dom.window.document.querySelector('#phone-device-default');
    assert.ok(select);
    assert.equal(select.value, 'Mobile');
    select.value = 'Landline';
    select.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const message = harness.sentMessages.find((entry) => entry.type === 'JOB_DATASOURCE_PROFILE_UPDATE');
    assert.equal(message.profile.defaults.phoneDeviceType, 'Landline');
  } finally { harness.cleanup(); }
});

test('panel offers local saving while a page is ready to continue', async () => {
  const run = {
    status: 'page_ready',
    pageNumber: 1,
    actionRequired: [],
    optionalUnresolved: [],
    reviewRequired: [],
    audit: [],
  };
  const harness = await setupPanel({ run });

  try {
    const { document } = harness.dom.window;
    assert.equal(document.querySelector('#primary-action').textContent.trim(), 'Continue to next page');
    assert.equal(document.querySelector('#save-answers').hidden, false);
    assert.equal(document.querySelector('#save-answers').textContent.trim(), 'Save filled values');

    document.querySelector('#save-answers').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(harness.sentMessages.some((message) => message.type === 'JOB_RUN_SAVE_ANSWERS'), true);
    assert.equal(document.querySelector('#run-state').textContent.trim(), 'Page ready');
    assert.match(document.querySelector('#status').textContent, /Saved 2 filled values locally/i);
  } finally {
    harness.cleanup();
  }
});

test('save feedback stays beside the controls through pending saves and background refreshes', async () => {
  const run = { status: 'waiting_user', pageNumber: 1, startedAt: 'application-1' };
  const harness = await setupPanel({ run });
  let finishSave;
  const original = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = (message) => {
    if (message.type !== 'JOB_RUN_SAVE_ANSWERS') return original(message);
    harness.sentMessages.push(message);
    return new Promise((resolve) => { finishSave = resolve; });
  };
  try {
    const { document } = harness.dom.window;
    const button = document.querySelector('#save-answers');
    const feedback = document.querySelector('#save-feedback');
    button.click();
    assert.equal(button.textContent, 'Saving…');
    assert.equal(button.disabled, true);
    assert.equal(feedback.hidden, false);
    assert.match(feedback.textContent, /Saving/i);
    assert.equal(feedback.getAttribute('role'), 'status');
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(harness.sentMessages.filter((message) => message.type === 'JOB_RUN_SAVE_ANSWERS').length, 1);
    finishSave({ ok: true, run, savedCount: 19 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(button.disabled, false);
    assert.match(feedback.textContent, /Saved 19 filled values locally/);
    for (const listener of harness.storageListeners) listener({ applicationRun: { newValue: { 7: run } } }, 'session');
    assert.match(feedback.textContent, /Saved 19 filled values locally/);
    assert.equal(document.querySelector('#run-state').textContent, 'Action required');
    document.querySelector('#primary-action').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(feedback.hidden, true);
  } finally { harness.cleanup(); }
});

for (const outcome of ['empty', 'failure', 'disconnected']) {
  test(`save feedback reports ${outcome} and allows another attempt`, async () => {
    const run = { status: 'page_ready', pageNumber: 1 };
    const harness = await setupPanel({ run });
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (message) => {
      if (message.type !== 'JOB_RUN_SAVE_ANSWERS') return original(message);
      if (outcome === 'disconnected') throw new Error('Connection lost');
      return outcome === 'empty' ? { ok: true, run, savedCount: 0 } : { ok: false, error: 'Storage is full' };
    };
    try {
      const { document } = harness.dom.window;
      document.querySelector('#save-answers').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const feedback = document.querySelector('#save-feedback');
      assert.equal(feedback.hidden, false);
      assert.match(feedback.textContent, outcome === 'empty' ? /No filled values.*nothing was saved/i : /Could not save.*(Storage is full|Connection lost)/i);
      assert.equal(feedback.dataset.state, outcome === 'empty' ? 'empty' : 'error');
      assert.equal(document.querySelector('#save-answers').disabled, false);
      chrome.runtime.sendMessage = original;
      document.querySelector('#save-answers').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.match(feedback.textContent, /Saved 2 filled values locally/);
    } finally { harness.cleanup(); }
  });
}

test('panel exports datasource backups through a generated download link', async () => {
  const harness = await setupPanel();

  try {
    harness.dom.window.document.querySelector('#export-datasource').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(harness.sentMessages.some((message) => message.type === 'JOB_DATASOURCE_EXPORT'), true);
    assert.equal(harness.createdUrls.length, 1);
    assert.deepEqual(harness.clickedDownloads, [{
      href: 'blob:mock-1',
      download: `job-application-datasource-${new Date().toISOString().slice(0, 10)}.json`,
    }]);
    assert.deepEqual(harness.revokedUrls, ['blob:mock-1']);
  } finally {
    harness.cleanup();
  }
});

test('panel shows learned changes and sends a user correction to the worker', async () => {
  const harness = await setupPanel({ datasource: { answerCount: 1, coverMessageCount: 0, learnedChanges: [
    { key: 'email', question: 'Email', answer: 'new@example.com', history: [{ answer: 'old@example.com' }], alternatives: [] },
  ] } });
  try {
    const document = harness.dom.window.document;
    assert.match(document.querySelector('#learned-change-list').textContent, /old@example.com/);
    const input = document.querySelector('#learned-change-list input');
    input.value = 'correct@example.com';
    document.querySelector('#learned-change-list button').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(harness.sentMessages.some((message) => message.type === 'JOB_DATASOURCE_CORRECT' && message.answer === 'correct@example.com'));
  } finally { harness.cleanup(); }
});

test('panel keeps opaque learned values out of correction inputs', async () => {
  const internalQuestion = 'cards|d20089ff-f389-44ef-9398-eec15ba7b6a4[field3]';
  const internalAnswer = '5ec01e56e42301ec004c2eaa25504002';
  const harness = await setupPanel({ datasource: {
    answerCount: 1,
    coverMessageCount: 0,
    learnedChanges: [{ key: internalQuestion, question: internalQuestion, answer: internalAnswer, history: [{ answer: internalAnswer }] }],
  } });
  try {
    const list = harness.dom.window.document.querySelector('#learned-change-list');
    const input = list.querySelector('input');
    assert.equal(input.value, '');
    assert.match(input.placeholder, /replace the hidden internal value/i);
    assert.doesNotMatch(input.getAttribute('aria-label'), new RegExp(internalQuestion, 'i'));
    assert.ok([...list.querySelectorAll('[data-internal-id-popover]')].every((popover) => popover.hidden));
  } finally { harness.cleanup(); }
});

test('confirming one correction preserves other unsaved correction drafts', async () => {
  const datasource = { answerCount: 2, coverMessageCount: 0, learnedChanges: [
    { key: 'city', question: 'City', answer: 'Old city' }, { key: 'country', question: 'Country', answer: 'Old country' },
  ] };
  const harness = await setupPanel({ datasource });
  const original = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = async (message) => message.type === 'JOB_DATASOURCE_CORRECT' ? { ok: true, datasource } : original(message);
  try {
    const document = harness.dom.window.document;
    const inputs = document.querySelectorAll('#learned-change-list input');
    inputs[0].value = 'New city';
    inputs[1].value = 'New country';
    inputs[1].dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
    document.querySelector('#learned-change-list button').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(document.querySelectorAll('#learned-change-list input')[1].value, 'New country');
  } finally { harness.cleanup(); }
});

test('answer workspace stays blank until a readable candidate is chosen', async () => {
  const suggestion = {
    tabId: 7, frameId: 3, applicationId: 'run-draft', pageSignature: 'page-one',
    field: { id: 'summary', handle: 'handle-summary' },
    candidates: [
      { sourceKey: 'one', sourceQuestion: 'Project history', answer: 'First candidate answer.', provenance: 'user', kind: 'related' },
      { sourceKey: 'two', sourceQuestion: 'Leadership history', answer: 'Second candidate answer.', provenance: 'user', kind: 'related' },
    ],
  };
  const run = { status: 'waiting_user', applicationId: 'run-draft', pageSignature: 'page-one', actionRequired: [{ fieldId: 'summary', label: 'Describe your experience', suggestion }], optionalUnresolved: [], reviewRequired: [], audit: [] };
  const harness = await setupPanel({ run });
  try {
    const row = harness.dom.window.document.querySelector('#action-required-list .result-item');
    assert.equal(row.querySelector('.result-label').textContent, 'Describe your experience');
    const draft = row.querySelector('[data-answer-draft]');
    assert.ok(draft);
    assert.equal(draft.value, '');
    assert.equal([...row.querySelectorAll('[data-choose-answer]')].length, 2);
    assert.deepEqual(pageMutationMessages(harness.sentMessages), []);
  } finally { harness.cleanup(); }
});

test('AI Use answer applies the selected draft in one click', async () => {
  const generatedSuggestion = {
    tabId: 7, frameId: 3, applicationId: 'run-ai', pageSignature: 'page-one',
    field: { id: 'summary', handle: 'handle-summary' },
    suggestions: [{ answer: 'I built event processing systems that match this role.', evidenceKeys: ['experience'] }],
    missingContext: '',
  };
  const run = { status: 'waiting_user', applicationId: 'run-ai', pageSignature: 'page-one', actionRequired: [{ fieldId: 'summary', label: 'Why are you a good fit?', generatedSuggestion }], optionalUnresolved: [], reviewRequired: [], audit: [] };
  const harness = await setupPanel({ run });
  try {
    const row = harness.dom.window.document.querySelector('#action-required-list .result-item');
    assert.equal(row.querySelector('.result-label').textContent, 'Why are you a good fit?');
    row.querySelector('[data-choose-generated-answer]').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const sent = harness.sentMessages.find(message => message.type === 'JOB_RUN_APPLY_DRAFT');
    assert.equal(sent.answer, 'I built event processing systems that match this role.');
  } finally { harness.cleanup(); }
});

test('AI suggestions remain selectable when saved evidence is an internal ID', async () => {
  const suggestion = {
    tabId: 7, frameId: 3, applicationId: 'run-mixed', pageSignature: 'page-one',
    field: { id: 'summary', handle: 'handle-summary' },
    candidates: [{ sourceKey: 'legacy_id', sourceQuestion: 'Legacy response', answer: 'cards|d20089ff-f389-44ef-9398-eec15ba7b6a4[field1]' }],
  };
  const generatedSuggestion = {
    tabId: 7, frameId: 3, applicationId: 'run-mixed', pageSignature: 'page-one',
    field: { id: 'summary', handle: 'handle-summary' },
    suggestions: [{ answer: 'I build reliable event processing systems that fit this role.', evidenceKeys: [] }],
  };
  const run = {
    status: 'waiting_user', applicationId: 'run-mixed', pageSignature: 'page-one',
    actionRequired: [{ fieldId: 'summary', label: 'Why are you a good fit?', suggestion, generatedSuggestion }],
    optionalUnresolved: [], reviewRequired: [], audit: [],
  };
  const harness = await setupPanel({ run });
  try {
    const row = harness.dom.window.document.querySelector('#action-required-list .result-item');
    const draft = row.querySelector('[data-answer-draft]');
    assert.ok(draft, 'a readable AI suggestion needs an editable answer destination');
    row.querySelector('[data-choose-generated-answer]').click();
    assert.equal(draft.value, 'I build reliable event processing systems that fit this role.');
    row.querySelector('[data-send-answer]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(harness.sentMessages.find((message) => message.type === 'JOB_RUN_APPLY_DRAFT')?.answer, draft.value);
  } finally { harness.cleanup(); }
});

test('missing job context exposes a compact description editor and regenerates drafts', async () => {
  const generatedSuggestion = { tabId: 7, frameId: 3, applicationId: 'run-context', pageSignature: 'page-one', field: { id: 'summary', handle: 'handle-summary' }, suggestions: [], missingContext: 'Add the job description.' };
  const refreshed = { status: 'waiting_user', applicationId: 'run-context', pageSignature: 'page-one', jobContext: { jobDescription: 'Build distributed systems.' }, actionRequired: [{ fieldId: 'summary', label: 'Why this role?', generatedSuggestion: { ...generatedSuggestion, suggestions: [{ answer: 'I have relevant systems experience.', evidenceKeys: [] }], missingContext: '' } }], optionalUnresolved: [], reviewRequired: [], audit: [] };
  const run = { status: 'waiting_user', applicationId: 'run-context', pageSignature: 'page-one', actionRequired: [{ fieldId: 'summary', label: 'Why this role?', generatedSuggestion }], optionalUnresolved: [], reviewRequired: [], audit: [] };
  const harness = await setupPanel({ run, generateResponse: { ok: true, run: refreshed } });
  try {
    const row = harness.dom.window.document.querySelector('#action-required-list .result-item');
    const editor = row.querySelector('[data-job-description]');
    assert.ok(editor);
    editor.value = 'Build distributed systems.';
    row.querySelector('[data-generate-suggestions]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const message = harness.sentMessages.find((entry) => entry.type === 'JOB_RUN_GENERATE_SUGGESTIONS');
    assert.equal(message.jobDescription, 'Build distributed systems.');
    assert.equal(harness.dom.window.document.querySelector('[data-choose-generated-answer]').textContent, 'Use this answer');
  } finally { harness.cleanup(); }
});

test('choosing a candidate and editing it changes only the transient draft', async () => {
  const suggestion = { tabId: 7, frameId: 3, applicationId: 'run-edit', pageSignature: 'page-one', field: { id: 'summary', handle: 'handle-summary' }, candidates: [{ sourceKey: 'story', sourceQuestion: 'Saved story', answer: 'Candidate answer verbatim.', provenance: 'user', kind: 'related' }] };
  const run = { status: 'waiting_user', applicationId: 'run-edit', pageSignature: 'page-one', actionRequired: [{ fieldId: 'summary', label: 'Experience question', suggestion }], optionalUnresolved: [], reviewRequired: [], audit: [] };
  const harness = await setupPanel({ run });
  try {
    const row = harness.dom.window.document.querySelector('#action-required-list .result-item');
    row.querySelector('[data-edit-candidate]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const draft = row.querySelector('[data-answer-draft]');
    assert.equal(draft.value, 'Candidate answer verbatim.');
    assert.deepEqual(pageMutationMessages(harness.sentMessages), []);
    row.querySelector('[data-edit-answer]').click();
    draft.value = 'A freely edited answer.';
    draft.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(draft.value, 'A freely edited answer.');
    assert.deepEqual(pageMutationMessages(harness.sentMessages), []);
  } finally { harness.cleanup(); }
});

test('rewrite prompt sends the question context and replaces only the draft', async () => {
  let shouldFail = false;
  const suggestion = { tabId: 7, frameId: 3, applicationId: 'run-rewrite', pageSignature: 'page-one', field: { id: 'summary', handle: 'handle-summary' }, candidates: [{ sourceKey: 'story', sourceQuestion: 'Saved story', answer: 'Current draft.', provenance: 'user', kind: 'related' }] };
  const run = { status: 'waiting_user', applicationId: 'run-rewrite', pageSignature: 'page-one', actionRequired: [{ fieldId: 'summary', label: 'Experience question', suggestion }], optionalUnresolved: [], reviewRequired: [], audit: [] };
  const harness = await setupPanel({ run, rewriteResponse: (message) => shouldFail ? { ok: false, error: 'Rewrite unavailable' } : { ok: true, answer: 'Rewritten by the configured model.' } });
  try {
    const row = harness.dom.window.document.querySelector('#action-required-list .result-item');
    row.querySelector('[data-edit-candidate]').click();
    row.querySelector('[data-rewrite-answer]').click();
    const prompt = row.querySelector('[data-rewrite-prompt]');
    assert.ok(prompt);
    prompt.value = 'Make this more concise and confident.';
    prompt.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
    row.querySelector('[data-submit-rewrite]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const message = harness.sentMessages.find((entry) => entry.type === 'JOB_RUN_REWRITE_ANSWER');
    assert.equal(message.applicationId, 'run-rewrite');
    assert.equal(message.pageSignature, 'page-one');
    assert.equal(message.fieldId, 'summary');
    assert.equal(message.question, 'Experience question');
    assert.equal(message.draft, 'Current draft.');
    assert.equal(message.instruction, 'Make this more concise and confident.');
    assert.equal(row.querySelector('[data-answer-draft]').value, 'Rewritten by the configured model.');
    shouldFail = true;
    row.querySelector('[data-rewrite-answer]').click();
    prompt.value = 'Try again';
    row.querySelector('[data-submit-rewrite]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(row.querySelector('[data-answer-draft]').value, 'Rewritten by the configured model.');
    assert.match(harness.dom.window.document.querySelector('#status').textContent, /Rewrite unavailable/i);
  } finally { harness.cleanup(); }
});

test('send to form stays disabled until a draft exists and preserves it on apply failure', async () => {
  const suggestion = { tabId: 7, frameId: 3, applicationId: 'run-send', pageSignature: 'page-one', field: { id: 'summary', handle: 'handle-summary' }, candidates: [{ sourceKey: 'story', sourceQuestion: 'Saved story', answer: 'Candidate answer.', provenance: 'user', kind: 'related' }] };
  const run = { status: 'waiting_user', applicationId: 'run-send', pageSignature: 'page-one', actionRequired: [{ fieldId: 'summary', label: 'Experience question', suggestion }], optionalUnresolved: [], reviewRequired: [], audit: [] };
  const harness = await setupPanel({ run, approveSuggestionResponse: { ok: false, error: 'Page changed' } });
  try {
    const row = harness.dom.window.document.querySelector('#action-required-list .result-item');
    const send = row.querySelector('[data-send-answer]');
    assert.ok(send);
    assert.equal(send.disabled, true);
    row.querySelector('[data-edit-candidate]').click();
    row.querySelector('[data-edit-answer]').click();
    const draft = row.querySelector('[data-answer-draft]');
    draft.value = 'Exact answer to send';
    draft.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
    send.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const message = harness.sentMessages.find((entry) => entry.type === 'JOB_RUN_APPROVE_SUGGESTION');
    assert.equal(harness.sentMessages.filter((entry) => entry.type === 'JOB_RUN_APPROVE_SUGGESTION').length, 1);
    assert.equal(message.sourceKey, 'story');
    assert.equal(message.answer, 'Exact answer to send');
    assert.equal(draft.value, 'Exact answer to send');
    assert.match(harness.dom.window.document.querySelector('#status').textContent, /Page changed/i);
  } finally { harness.cleanup(); }
});

test('manual draft sends through the guarded apply path with the exact edited answer', async () => {
  const run = { status: 'waiting_user', applicationId: 'run-manual', pageSignature: 'page-one', frame: { frameId: 4 }, actionRequired: [{ fieldId: 'salary', label: 'Expected salary' }], optionalUnresolved: [], reviewRequired: [], audit: [] };
  const harness = await setupPanel({ run });
  try {
    const row = harness.dom.window.document.querySelector('#action-required-list .result-item');
    const draft = row.querySelector('[data-answer-draft]');
    draft.value = '₹25,00,000';
    draft.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
    row.querySelector('[data-send-answer]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const message = harness.sentMessages.find((entry) => entry.type === 'JOB_RUN_APPLY_DRAFT');
    assert.equal(message.fieldId, 'salary');
    assert.equal(message.answer, '₹25,00,000');
    assert.equal(message.frameId, 4);
  } finally { harness.cleanup(); }
});

test('manual Send to form preserves the draft and reports an apply failure', async () => {
  const run = { status: 'waiting_user', applicationId: 'run-manual-failure', pageSignature: 'page-one', actionRequired: [{ fieldId: 'salary', label: 'Expected salary' }], optionalUnresolved: [], reviewRequired: [], audit: [] };
  const harness = await setupPanel({ run, applyDraftResponse: { ok: false, error: 'Application page changed' } });
  try {
    const row = harness.dom.window.document.querySelector('#action-required-list .result-item');
    const draft = row.querySelector('[data-answer-draft]');
    draft.value = '₹25,00,000';
    draft.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
    row.querySelector('[data-send-answer]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const mutationMessages = pageMutationMessages(harness.sentMessages);
    assert.equal(mutationMessages.length, 1);
    assert.equal(mutationMessages[0].type, 'JOB_RUN_APPLY_DRAFT');
    assert.equal(mutationMessages[0].fieldId, 'salary');
    assert.equal(mutationMessages[0].answer, '₹25,00,000');
    assert.equal(draft.value, '₹25,00,000');
    assert.match(harness.dom.window.document.querySelector('#status').textContent, /Application page changed/i);
  } finally { harness.cleanup(); }
});

test('Send to form keeps the draft and reports an error when the worker omits the updated run', async () => {
  const run = { status: 'waiting_user', applicationId: 'run-incomplete', pageSignature: 'page-one', actionRequired: [{ fieldId: 'salary', label: 'Expected salary' }], optionalUnresolved: [], reviewRequired: [], audit: [] };
  const harness = await setupPanel({ run, applyDraftResponse: { ok: true } });
  try {
    const row = harness.dom.window.document.querySelector('#action-required-list .result-item');
    const draft = row.querySelector('[data-answer-draft]');
    draft.value = '₹25,00,000';
    draft.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
    row.querySelector('[data-send-answer]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(draft.value, '₹25,00,000');
    assert.match(harness.dom.window.document.querySelector('#status').textContent, /updated application state|could not confirm/i);
  } finally { harness.cleanup(); }
});

test('candidate-backed drafts retain plural source keys when sent for approval', async () => {
  const suggestion = {
    tabId: 7, frameId: 3, applicationId: 'run-multi-source', pageSignature: 'page-one', field: { id: 'summary', handle: 'handle-summary' },
    candidates: [{ sourceKeys: ['project', 'leadership'], sourceQuestion: 'Saved profile evidence', answer: 'Combined evidence answer.', provenance: 'planner', kind: 'planner' }],
  };
  const run = { status: 'waiting_user', applicationId: 'run-multi-source', pageSignature: 'page-one', actionRequired: [{ fieldId: 'summary', label: 'Experience question', suggestion }], optionalUnresolved: [], reviewRequired: [], audit: [] };
  const harness = await setupPanel({ run });
  try {
    const row = harness.dom.window.document.querySelector('#action-required-list .result-item');
    row.querySelector('[data-edit-candidate]').click();
    row.querySelector('[data-send-answer]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const message = harness.sentMessages.find((entry) => entry.type === 'JOB_RUN_APPROVE_SUGGESTION');
    assert.deepEqual(message.sourceKeys, ['project', 'leadership']);
    assert.equal(message.candidateKind, 'planner');
    assert.equal(message.answer, 'Combined evidence answer.');
  } finally { harness.cleanup(); }
});

test('Send to form preserves the original draft whitespace', async () => {
  const run = { status: 'waiting_user', applicationId: 'run-whitespace', pageSignature: 'page-one', actionRequired: [{ fieldId: 'salary', label: 'Expected salary' }], optionalUnresolved: [], reviewRequired: [], audit: [] };
  const harness = await setupPanel({ run });
  try {
    const row = harness.dom.window.document.querySelector('#action-required-list .result-item');
    const draft = row.querySelector('[data-answer-draft]');
    draft.value = '  Preserve this exact answer.  ';
    draft.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
    row.querySelector('[data-send-answer]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(harness.sentMessages.find((entry) => entry.type === 'JOB_RUN_APPLY_DRAFT').answer, '  Preserve this exact answer.  ');
  } finally { harness.cleanup(); }
});

test('a delayed rewrite cannot overwrite a newer draft edit', async () => {
  let resolveRewrite;
  const rewriteResponse = () => new Promise((resolve) => { resolveRewrite = resolve; });
  const suggestion = { tabId: 7, frameId: 3, applicationId: 'run-revision', pageSignature: 'page-one', field: { id: 'summary', handle: 'handle-summary' }, candidates: [{ sourceKey: 'story', sourceQuestion: 'Saved story', answer: 'Initial answer.', provenance: 'user', kind: 'related' }] };
  const run = { status: 'waiting_user', applicationId: 'run-revision', pageSignature: 'page-one', actionRequired: [{ fieldId: 'summary', label: 'Experience question', suggestion }], optionalUnresolved: [], reviewRequired: [], audit: [] };
  const harness = await setupPanel({ run, rewriteResponse });
  try {
    const row = harness.dom.window.document.querySelector('#action-required-list .result-item');
    row.querySelector('[data-edit-candidate]').click();
    row.querySelector('[data-rewrite-answer]').click();
    const draft = row.querySelector('[data-answer-draft]');
    const prompt = row.querySelector('[data-rewrite-prompt]');
    prompt.value = 'Make it shorter.';
    prompt.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
    row.querySelector('[data-submit-rewrite]').click();
    assert.equal(draft.disabled, true);
    assert.equal(prompt.disabled, true);
    draft.value = 'Newer draft typed while waiting.';
    draft.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
    resolveRewrite({ ok: true, answer: 'Stale rewritten answer.' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(draft.value, 'Newer draft typed while waiting.');
  } finally { harness.cleanup(); }
});

test('a delayed apply cannot clear a newer draft edit', async () => {
  let resolveApply;
  const applyDraftResponse = () => new Promise((resolve) => { resolveApply = resolve; });
  const run = { status: 'waiting_user', applicationId: 'run-apply-revision', pageSignature: 'page-one', actionRequired: [{ fieldId: 'salary', label: 'Expected salary' }], optionalUnresolved: [], reviewRequired: [], audit: [] };
  const harness = await setupPanel({ run, applyDraftResponse });
  try {
    const row = harness.dom.window.document.querySelector('#action-required-list .result-item');
    const draft = row.querySelector('[data-answer-draft]');
    draft.value = 'First draft';
    draft.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
    row.querySelector('[data-send-answer]').click();
    assert.equal(draft.disabled, true);
    draft.value = 'Newer draft';
    draft.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
    resolveApply({ ok: true, run });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const latestDraft = harness.dom.window.document.querySelector('[data-answer-draft]');
    assert.equal(latestDraft.value, 'Newer draft');
  } finally { harness.cleanup(); }
});

test('opaque candidates stay hidden and expose no draft or apply controls', async () => {
  const opaque = 'cards|d20089ff-f389-44ef-9398-eec15ba7b6a4[field1]';
  const suggestion = { tabId: 7, frameId: 3, applicationId: 'run-opaque', pageSignature: 'page-one', field: { id: 'device', handle: 'handle-device' }, candidates: [{ sourceKey: 'device', sourceQuestion: 'Device type', answer: opaque, provenance: 'user', kind: 'draft' }] };
  const run = { status: 'waiting_user', applicationId: 'run-opaque', pageSignature: 'page-one', actionRequired: [{ fieldId: 'device', label: 'Phone device type', suggestion }], optionalUnresolved: [], reviewRequired: [], audit: [] };
  const harness = await setupPanel({ run });
  try {
    const row = harness.dom.window.document.querySelector('#action-required-list .result-item');
    assert.equal(row.querySelector('[data-internal-id-popover]'), null);
    assert.equal(row.querySelector('[data-choose-answer]'), null);
    assert.equal(row.querySelector('[data-answer-draft]'), null);
    assert.equal(row.querySelector('[data-edit-answer]'), null);
    assert.equal(row.querySelector('[data-rewrite-answer]'), null);
    assert.equal(row.querySelector('[data-send-answer]'), null);
  } finally { harness.cleanup(); }
});

test('failed AI work exposes retry and validation uses the validation-only protocol', async () => {
  const run = { status: 'waiting_user', applicationId: 'run-ai', pageSignature: 'page-one', progress: 'local_fill_complete', aiOperations: { summary: { status: 'failed' } }, actionRequired: [], optionalUnresolved: [], reviewRequired: [], audit: [] };
  const harness = await setupPanel({ run });
  try {
    harness.dom.window.document.querySelector('[data-retry-ai]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.dom.window.document.querySelector('#check-page').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(harness.sentMessages.some(({ type }) => type === 'JOB_RUN_RETRY_AI'));
    assert.ok(harness.sentMessages.some(({ type }) => type === 'JOB_RUN_VALIDATE_PAGE'));
  } finally { harness.cleanup(); }
});

test('unanswered fields can search saved answers and use a returned candidate', async () => {
  const run = { status: 'waiting_user', applicationId: 'run-search', pageSignature: 'page-one', actionRequired: [{ fieldId: 'salary', label: 'Expected salary' }], optionalUnresolved: [], reviewRequired: [], audit: [] };
  const searchResponse = { ok: true, candidates: [{ sourceKey: 'salary_saved', answer: '₹25,00,000', sourceQuestion: 'Salary expectation' }], run };
  const harness = await setupPanel({ run, searchResponse });
  try {
    const row = harness.dom.window.document.querySelector('#action-required-list .result-item');
    row.querySelector('[data-search-query]').value = 'salary';
    row.querySelector('[data-search-answers]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    row.querySelector('[data-search-result]').click();
    assert.equal(row.querySelector('[data-answer-draft]').value, '₹25,00,000');
    assert.equal(harness.sentMessages.find(({ type }) => type === 'JOB_RUN_SEARCH_ANSWERS').fieldId, 'salary');
  } finally { harness.cleanup(); }
});

test('saved-answer search remains available beside a recommendation', async () => {
  const suggestion = {
    tabId: 7, frameId: 3, applicationId: 'run-search-recommendation', pageSignature: 'page-one',
    field: { id: 'salary', handle: 'salary-h' },
    candidates: [{ sourceKey: 'salary_first', answer: '₹20,00,000', sourceQuestion: 'Expected salary', kind: 'review' }],
  };
  const run = { status: 'waiting_user', applicationId: 'run-search-recommendation', pageSignature: 'page-one', actionRequired: [{ fieldId: 'salary', label: 'Expected salary', suggestion }], optionalUnresolved: [], reviewRequired: [], audit: [] };
  const harness = await setupPanel({ run });
  try {
    const row = harness.dom.window.document.querySelector('#action-required-list .result-item');
    assert.ok(row.querySelector('[data-search-query]'));
    assert.ok(row.querySelector('[data-search-answers]'));
  } finally { harness.cleanup(); }
});

test('employment choices select one profile entry for a section', async () => {
  const run = { status: 'waiting_user', applicationId: 'run-work', pageSignature: 'page-one', frame: { frameId: 4 }, employmentChoices: [{ sectionId: 'work-1', label: 'Employment 1', employers: [{ id: 'emp-2', company: 'Second Co' }] }], actionRequired: [], optionalUnresolved: [], reviewRequired: [], audit: [] };
  const harness = await setupPanel({ run });
  try {
    harness.dom.window.document.querySelector('[data-employment-choice]').value = 'emp-2';
    harness.dom.window.document.querySelector('[data-employment-choice]').dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(harness.sentMessages.some(({ type, frameId, sectionId, employmentId }) => type === 'JOB_RUN_SELECT_EMPLOYMENT' && frameId === 4 && sectionId === 'work-1' && employmentId === 'emp-2'));
  } finally { harness.cleanup(); }
});

test('Review on site focuses the first audit field when no review field exists', async () => {
  const run = {
    status: 'ready_for_user_submit', applicationId: 'run-review', pageSignature: 'page-one', frame: { frameId: 4 },
    actionRequired: [], optionalUnresolved: [], reviewRequired: [], audit: [{ key: 'portfolio', label: 'Portfolio link' }],
  };
  const harness = await setupPanel({ run });
  try {
    harness.dom.window.document.querySelector('#primary-action').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(harness.sentMessages.some(({ type, fieldId }) => type === 'JOB_RUN_FOCUS_FIELD' && fieldId === 'portfolio'));
  } finally { harness.cleanup(); }
});

test('editing a default preserves every employment entry and marks the changed default confirmed', async () => {
  const profile = { employment: [{ id: 'one', company: 'First Co', roles: [{ title: 'Engineer' }] }, { id: 'two', company: 'Second Co' }], defaults: { relatedToHiringCompany: 'Unknown', knownAtHiringCompany: 'Unknown', phoneDeviceType: 'Unknown' }, defaultsConfirmation: {} };
  const harness = await setupPanel({ datasource: { answerCount: 0, coverMessageCount: 0, profile } });
  try {
    const select = harness.dom.window.document.querySelector('#related-default');
    select.value = 'No';
    select.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const message = harness.sentMessages.find(({ type }) => type === 'JOB_DATASOURCE_PROFILE_UPDATE');
    assert.deepEqual(message.profile.employment, profile.employment);
    assert.equal(message.profile.defaultsConfirmation.relatedToHiringCompany, 'confirmed');
  } finally { harness.cleanup(); }
});
