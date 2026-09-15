import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';
import { JSDOM } from 'jsdom';

test('fresh classic bundle executes and same-version reinjection preserves values and one listener', async () => {
  const bundle = await readFile(new URL('../dist/content.js', import.meta.url), 'utf8');
  const dom = new JSDOM('<form><label>Current CTC<textarea id="ctc">Unsaved synthetic value</textarea></label></form>');
  const listeners = new Set();
  const context = createContext({ document: dom.window.document, setTimeout, clearTimeout, console, chrome: { runtime: { sendMessage: async () => ({}), onMessage: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) } } } });
  new Script(bundle).runInContext(context);
  new Script(bundle).runInContext(context);
  assert.equal(listeners.size, 1);
  const ping = await new Promise(resolve => [...listeners][0]({ type: 'JOB_APP_PING' }, {}, resolve));
  assert.equal(ping.version, 'autofill-ux-5');
  const result = await new Promise(resolve => [...listeners][0]({ type: 'JOB_APP_INSPECT' }, {}, resolve));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.inspection.fields[0].label, 'Current CTC');
  assert.equal(result.inspection.fields[0].currentValue, 'Unsaved synthetic value');
  dom.window.close();
});

test('classic content listener inspects the live focused descriptor and exact raw edit state', async () => {
  const bundle = await readFile(new URL('../dist/content.js', import.meta.url), 'utf8');
  const dom = new JSDOM('<form><label>Full name<input id="name"></label><label>Search<input type="search" id="search"></label></form>', {url: 'https://jobs.example.com/apply'});
  const listeners = [];
  const context = createContext({document: dom.window.document, setTimeout, clearTimeout, console, chrome: {runtime: {
    sendMessage: async () => ({}), onMessage: {addListener: listener => listeners.push(listener)},
  }}});
  new Script(bundle).runInContext(context);
  const dispatch = message => new Promise(resolve => {
    if (listeners[0](message, {}, resolve) === false) resolve({ok: false, unhandled: true});
  });
  const input = dom.window.document.querySelector('#name');
  input.focus();
  const first = await dispatch({type: 'JOB_APP_INSPECT_INLINE'});
  assert.equal(first.ok, true);
  assert.equal(first.focusedFieldId, first.inspection.fields[0].id);
  assert.equal(first.focusedHandle, first.inspection.fields[0].handle);
  assert.equal(first.inspection.page.url, 'https://jobs.example.com/apply');
  assert.equal(first.rawValue, '');
  assert.equal(first.editRevision, 0);
  input.value = ' ';
  input.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
  const changed = await dispatch({type: 'JOB_APP_INSPECT_INLINE'});
  assert.equal(changed.rawValue, ' ');
  assert.equal(changed.inspection.fields[0].currentValue, '');
  assert.equal(changed.editRevision, 1);
  dom.window.document.querySelector('#search').focus();
  const utility = await dispatch({type: 'JOB_APP_INSPECT_INLINE'});
  assert.equal(utility.focusedFieldId, null);
  assert.equal(utility.focusedHandle, null);
  assert.equal(utility.rawValue, null);
  dom.window.close();
});

test('disabled site status keeps the content script inert until explicitly re-enabled', async () => {
  const bundle = await readFile(new URL('../dist/content.js', import.meta.url), 'utf8');
  const dom = new JSDOM('<form><label>Full name<input id="name"></label></form>', {url: 'https://jobs.example.com/apply', pretendToBeVisual: true});
  const listeners = [];
  const messages = [];
  const context = createContext({document: dom.window.document, setTimeout, clearTimeout, console, chrome: {runtime: {
    sendMessage: async message => {
      messages.push(message);
      if (message.type === 'JOB_APP_SITE_STATUS') return {ok: true, enabled: false, supported: true};
      return {ok: true, candidates: []};
    }, onMessage: {addListener: listener => listeners.push(listener)},
  }}});
  new Script(bundle).runInContext(context);
  await new Promise(resolve => setTimeout(resolve, 0));
  const dispatch = message => new Promise(resolve => listeners[0](message, {}, resolve));
  const input = dom.window.document.querySelector('#name');
  input.focus(); input.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(messages.filter(message => message.type === 'JOB_INLINE_QUERY').length, 0);
  assert.equal(dom.window.document.querySelectorAll('[data-job-inline-autofill]').length, 0);
  const disabled = await dispatch({type: 'JOB_APP_INSPECT'});
  assert.equal(disabled.ok, false);
  assert.equal(disabled.disabled, true);
  await dispatch({type: 'JOB_APP_SITE_STATE_CHANGED', enabled: true});
  input.focus(); input.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(messages.filter(message => message.type === 'JOB_INLINE_QUERY').length, 1);
  assert.equal(listeners.length, 1);
  await dispatch({type: 'JOB_APP_SITE_STATE_CHANGED', enabled: false});
  assert.equal(dom.window.document.querySelectorAll('[data-job-inline-autofill]').length, 0);
  dom.window.close();
});

test('bundled inline suggestions approve through the live listener once and stay out of page inspection and capture', async () => {
  const bundle = await readFile(new URL('../dist/content.js', import.meta.url), 'utf8');
  const dom = new JSDOM('<form aria-label="Job application"><label>Name<input id="name"></label><label>Existing answer<textarea id="existing">Kept page answer</textarea></label></form>', {url: 'https://jobs.example.com/apply', pretendToBeVisual: true});
  const document = dom.window.document;
  const listeners = []; const messages = [];
  const context = createContext({document, setTimeout, clearTimeout, console, chrome: {runtime: {
    sendMessage: async message => {
      messages.push(message);
      if (message.type === 'JOB_INLINE_ACCEPT') return new Promise(() => {});
      return {ok: true, sessionId: 's1', requestId: message.requestId, candidates: [{candidateId: 'c1', answer: 'Ada', sourceQuestion: 'Name', requiresApproval: true}]};
    }, onMessage: {addListener: listener => listeners.push(listener)},
  }}});
  new Script(bundle).runInContext(context); new Script(bundle).runInContext(context);
  const dispatch = message => new Promise(resolve => listeners[0](message, {}, resolve));
  const input = document.querySelector('#name');
  const formEvents = [];
  input.addEventListener('input', () => formEvents.push('input'));
  input.addEventListener('change', () => formEvents.push('change'));
  input.focus(); input.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(messages.filter(m => m.type === 'JOB_INLINE_QUERY').length, 1);
  assert.equal(document.querySelectorAll('[data-job-inline-autofill]').length, 1);
  assert.equal(listeners.length, 1);
  const inspectedBeforeApply = await dispatch({type: 'JOB_APP_INSPECT'});
  assert.deepEqual(Array.from(inspectedBeforeApply.inspection.fields, field => field.label), ['Name', 'Existing answer']);
  assert.doesNotMatch(JSON.stringify(inspectedBeforeApply.inspection), /Application answer suggestions|Saved answers/);
  const capturedBeforeApply = await dispatch({type: 'JOB_APP_CAPTURE'});
  assert.deepEqual(Array.from(capturedBeforeApply.records, record => record.question), ['Existing answer']);
  const key = (key, options = {}, target = input) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key, bubbles: true, composed: true, cancelable: true, ...options}));
  key('ArrowDown');
  assert.equal(key('Tab'), false);
  const acceptanceToken = messages.find(m => m.type === 'JOB_INLINE_ACCEPT').acceptanceToken;
  const state = await dispatch({type: 'JOB_APP_INSPECT_INLINE'});
  assert.equal(state.focusedHandle, state.inspection.fields[0].handle);
  const field = state.inspection.fields[0];
  const decisions = [{fieldId: field.id, handle: field.handle, action: 'fill', approved: true, value: 'Ada', sensitivity: 'safe', confidence: 'high', expectedRawValue: '', expectedEditRevision: 0}];
  const wrongToken = await dispatch({type: 'JOB_APP_APPLY', decisions, approvalGuard: {acceptanceToken: 'invalid'}});
  assert.equal(wrongToken.result.applied.length, 0);
  assert.equal(input.value, '');
  // A rejected token must not consume the deliberate selection's pending approval.
  const applied = await dispatch({type: 'JOB_APP_APPLY', decisions, approvalGuard: {acceptanceToken}});
  assert.equal(applied.result.applied.length, 1);
  assert.equal(input.value, 'Ada');
  assert.deepEqual(formEvents, ['input', 'change']);
  const capturedAfterApply = await dispatch({type: 'JOB_APP_CAPTURE'});
  assert.deepEqual(Array.from(capturedAfterApply.records, record => record.question), ['Name', 'Existing answer']);
  assert.doesNotMatch(JSON.stringify(capturedAfterApply.records), /Application answer suggestions|Saved answers/);
  assert.equal(listeners.length, 1);
  dom.window.close();
});


test('content rejects stale document and region identities without changing a field', async () => {
  const bundle = await readFile(new URL('../dist/content.js', import.meta.url), 'utf8');
  const dom = new JSDOM('<form><label>Full name<input id="name"></label><button>Next</button></form>', {url: 'https://jobs.example.com/apply'});
  const listeners = [];
  const context = createContext({document: dom.window.document, setTimeout, clearTimeout, console, chrome: {runtime: {
    sendMessage: async () => ({}), onMessage: {addListener: listener => listeners.push(listener)},
  }}});
  new Script(bundle).runInContext(context);
  const dispatch = message => new Promise(resolve => listeners[0](message, {}, resolve));
  try {
    const inspected = await dispatch({type: 'JOB_APP_INSPECT'});
    assert.equal(inspected.ok, true, inspected.error);
    const {destination, fields} = inspected.inspection;
    assert.ok(destination.documentId);
    for (const changed of [{...destination, documentId: 'old-document'}, {...destination, regionId: 'old-region'}]) {
      const response = await dispatch({type: 'JOB_APP_APPLY', destination: changed, decisions: [{fieldId: fields[0].id, handle: fields[0].handle, action: 'fill', value: 'Changed'}]});
      assert.equal(response.code, 'destination_changed');
      assert.equal(dom.window.document.querySelector('input').value, '');
    }
    dom.window.history.pushState({}, '', '/different');
    assert.equal((await dispatch({type: 'JOB_APP_CAPTURE', destination})).code, 'destination_changed');
  } finally {dom.window.close();}
});

test('ambiguous forms expose only the focused control to inline suggestions and refuse bulk fill', async () => {
  const bundle = await readFile(new URL('../dist/content.js', import.meta.url), 'utf8');
  const dom = new JSDOM('<form><label>Full name<input id="one"></label></form><form><label>Full name<input id="two"></label></form>', {url: 'https://jobs.example.com/apply'});
  const listeners = [];
  const context = createContext({document: dom.window.document, setTimeout, clearTimeout, console, chrome: {runtime: {
    sendMessage: async () => ({}), onMessage: {addListener: listener => listeners.push(listener)},
  }}});
  new Script(bundle).runInContext(context);
  const dispatch = message => new Promise(resolve => listeners[0](message, {}, resolve));
  try {
    const input = dom.window.document.querySelector('#two');
    input.focus();
    const inspected = await dispatch({type: 'JOB_APP_INSPECT_INLINE'});
    assert.equal(inspected.inspection.destination.regionId, null);
    assert.equal(inspected.inspection.fields.length, 1);
    assert.equal(inspected.inspection.fields[0].handle, inspected.focusedHandle);
    const response = await dispatch({type: 'JOB_APP_APPLY', decisions: [{fieldId: inspected.focusedFieldId, handle: inspected.focusedHandle, action: 'fill', value: 'Unsafe bulk fill'}]});
    assert.equal(response.code, 'destination_changed');
    assert.equal(input.value, '');
    const selectedMessages = [];
    context.chrome.runtime.sendMessage = async message => {selectedMessages.push(message); return {};};
    await dispatch({type: 'JOB_APP_SELECT_FORM', token: 'test', expiresAt: Date.now() + 60000});
    input.click();
    assert.equal(selectedMessages.some(message => message.type === 'JOB_APP_FORM_SELECTED'), false, 'synthetic clicks cannot select a form');
    await dispatch({type: 'JOB_APP_CANCEL_FORM_SELECTION'});
  } finally {dom.window.close();}
});


test('armed form selection accepts a custom combobox without a native descriptor', async () => {
  const bundle = await readFile(new URL('../dist/content.js', import.meta.url), 'utf8');
  const dom = new JSDOM('<form><div role="combobox" aria-label="Country" tabindex="0"><span>Choose country</span></div><button>Next</button></form><form><label>Full name<input></label><button>Next</button></form>', {url: 'https://jobs.example.com/apply'});
  const listeners = [], clicks = [], sent = [];
  const document = dom.window.document;
  const addListener = document.addEventListener.bind(document);
  document.addEventListener = (type, callback, options) => {
    if (type === 'click' && options === true) clicks.push(callback);
    return addListener(type, callback, options);
  };
  const context = createContext({document, setTimeout, clearTimeout, console, chrome: {runtime: {
    sendMessage: async message => {sent.push(message); return {};}, onMessage: {addListener: listener => listeners.push(listener)},
  }}});
  new Script(bundle).runInContext(context);
  const dispatch = message => new Promise(resolve => listeners[0](message, {}, resolve));
  try {
    await dispatch({type: 'JOB_APP_SELECT_FORM', token: 'custom-token', expiresAt: Date.now() + 60000});
    const control = document.querySelector('[role="combobox"]');
    // Unit-test the installed callback. Browser trust itself is not synthesized by dispatchEvent.
    const inner = control.querySelector('span');
    clicks[0]({isTrusted: true, target: inner, composedPath: () => [inner, control, control.parentElement, document]});
    const selected = sent.find(message => message.type === 'JOB_APP_FORM_SELECTED');
    assert.ok(selected, 'custom control selects its application form');
    assert.equal(selected.token, 'custom-token');
    assert.equal(selected.fieldOnly, false);
    assert.ok(selected.destination.regionId);
  } finally {
    await dispatch({type: 'JOB_APP_CANCEL_FORM_SELECTION'});
    dom.window.close();
  }
});

test('synchronous invalidation during startup is caught without changing page values', async () => {
  const bundle = await readFile(new URL('../dist/content.js', import.meta.url), 'utf8');
  const dom = new JSDOM('<form><label>Name<input value="Unsaved name"></label></form>');
  const context = createContext({document: dom.window.document, setTimeout, clearTimeout, console, chrome: {runtime: {
    sendMessage() { throw new Error('Extension context invalidated.'); },
    onMessage: {addListener() {}},
  }}});
  assert.doesNotThrow(() => new Script(bundle).runInContext(context));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(dom.window.document.querySelector('input').value, 'Unsaved name');
  dom.window.close();
});
