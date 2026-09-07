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
  assert.equal(ping.version, 'general-reuse-1');
  const result = await new Promise(resolve => [...listeners][0]({ type: 'JOB_APP_INSPECT' }, {}, resolve));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.inspection.fields[0].label, 'Current CTC');
  assert.equal(result.inspection.fields[0].currentValue, 'Unsaved synthetic value');
  dom.window.close();
});
