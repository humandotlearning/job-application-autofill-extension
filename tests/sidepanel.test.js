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
        if (message.type === 'JOB_RUN_SAVE_ANSWERS') return { ok: true, run: { ...run, status: 'answers_saved' } };
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
        addListener: () => {},
      },
    },
  };

  await import(`../src/sidepanel.js?test=${Date.now()}-${Math.random()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));

  return {
    dom,
    localData,
    sentMessages,
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
    assert.equal(document.querySelector('#save-answers').hidden, true);
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

test('panel exports datasource backups through a generated download link', async () => {
  const harness = await setupPanel();

  try {
    harness.dom.window.document.querySelector('#export-datasource').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(harness.sentMessages.some((message) => message.type === 'JOB_DATASOURCE_EXPORT'), true);
    assert.equal(harness.createdUrls.length, 1);
    assert.deepEqual(harness.clickedDownloads, [{
      href: 'blob:mock-1',
      download: 'job-application-datasource-2026-09-04.json',
    }]);
    assert.deepEqual(harness.revokedUrls, ['blob:mock-1']);
  } finally {
    harness.cleanup();
  }
});
