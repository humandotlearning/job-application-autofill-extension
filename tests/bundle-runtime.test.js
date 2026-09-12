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
  assert.equal(ping.version, 'reliable-review-1');
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
