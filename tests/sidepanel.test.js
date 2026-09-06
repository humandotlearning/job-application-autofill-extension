import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { URL as NodeUrl } from 'node:url';
import { JSDOM } from 'jsdom';

const root = new NodeUrl('../', import.meta.url);

async function loadPanelHtml() {
  const html = await readFile(new NodeUrl('sidepanel.html', root), 'utf8');
  return html.replace(/<link rel="stylesheet"[^>]*>/, '').replace(/<script type="module" src="src\/sidepanel\.js"><\/script>/, '');
}

async function setupPanel({
  run = null,
  datasource = { answerCount: 3, coverMessageCount: 1 },
  localData = { openaiApiKey: 'sk-test', autoAdvancePages: false },
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
  globalThis.navigator = dom.window.navigator;
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
    document.querySelector('#primary-action').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(harness.sentMessages.some((message) => message.type === 'JOB_RUN_FOCUS_FIELD' && message.fieldId === 'work_auth'), true);
    assert.equal(harness.sentMessages.some((message) => message.type === 'JOB_RUN_SAVE_ANSWERS'), true);
    assert.equal(document.querySelector('#run-state').textContent.trim(), 'Answers saved');
    assert.equal(document.querySelector('#submit-instructions').hidden, false);
    assert.match(document.querySelector('#run-hint').textContent, /click Submit on the application site/i);
    assert.doesNotMatch(document.body.textContent, /Confirm & submit/i);
  } finally {
    harness.cleanup();
  }
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
