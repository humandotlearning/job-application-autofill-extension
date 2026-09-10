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
