import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { searchEvidence } from '../src/retrieval.js';

test('inline LinkedIn search shares one page snapshot per live inspection and keeps popup focus', async t => {
  const bundle = await readFile(new URL('../dist/content.js', import.meta.url), 'utf8');
  const dom = new JSDOM('<form><label>Professional profile<input id="profile" type="url"></label>'
    + Array.from({length: 30}, (_, i) => `<label>Question ${i}<input id="q${i}"></label>`).join('') + '</form>',
  {url: 'https://jobs.example.com/apply', pretendToBeVisual: true});
  t.after(() => dom.window.close());
  const document = dom.window.document, listeners = [], messages = [];
  const record = {key: 'linkedin', question: 'LinkedIn', answer: 'https://www.linkedin.com/in/synthetic', confirmationState: 'confirmed'};
  const context = createContext({document, setTimeout, clearTimeout, console, chrome: {runtime: {
    onMessage: {addListener: listener => listeners.push(listener)},
    sendMessage: async message => {
      messages.push(message);
      if (message.type === 'JOB_APP_SITE_STATUS') return {ok: true, enabled: true, supported: true};
      return {ok: true, sessionId: 'session', requestId: message.requestId,
        candidates: message.type === 'JOB_INLINE_SEARCH'
          ? searchEvidence({label: 'Professional profile', type: 'url'}, [record], {query: message.query}) : []};
    },
  }}});
  new Script(bundle).runInContext(context);
  await new Promise(resolve => setTimeout(resolve, 0));
  document.querySelector('#profile').focus();
  await new Promise(resolve => setTimeout(resolve, 0));
  const popup = document.querySelector('[data-job-inline-autofill]').shadowRoot;
  const search = popup.querySelector('[data-search]');
  search.focus();
  search.value = 'LinkedIn';
  search.dispatchEvent(new dom.window.Event('input', {bubbles: true, composed: true}));
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(messages.filter(message => message.type === 'JOB_INLINE_SEARCH').length, 1);
  assert.match(popup.querySelector('[role=option]').textContent, /linkedin.com\/in\/synthetic/);
  assert.equal(popup.activeElement, search);

  const page = await new Promise(resolve => listeners[0]({type: 'JOB_APP_INSPECT'}, {}, resolve));
  const field = page.inspection.fields.find(field => field.id === 'profile');

  // Count full DOM walks rather than using a machine-dependent timing threshold.
  const childNodes = Object.getOwnPropertyDescriptor(dom.window.Node.prototype, 'childNodes').get;
  let scans = 0;
  Object.defineProperty(document, 'childNodes', {get() { scans++; return childNodes.call(this); }});
  const inspected = await new Promise(resolve => listeners[0]({type: 'JOB_APP_INSPECT_INLINE', fieldId: field.id, handle: field.handle}, {}, resolve));
  assert.equal(inspected.ok, true);
  assert.equal(inspected.focusedFieldId, 'profile');
  assert.equal(inspected.rawValue, '');
  assert.equal(inspected.inspection.fields.length, 31);
  assert.equal(scans, 1, 'live focus checks must reuse the current inspection DOM snapshot');
});
