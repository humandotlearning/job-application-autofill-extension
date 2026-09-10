import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { descriptorForElement } from '../src/form-engine.js';
import { createInlineAutofill } from '../src/inline-autofill.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const candidates = [
  {candidateId: 'c1', answer: 'Synthetic Name', sourceQuestion: 'Full name', kind: 'equivalent', requiresApproval: true},
  {candidateId: 'c2', answer: 'Another complete answer\nSecond line', sourceQuestion: 'Preferred name', kind: 'equivalent', requiresApproval: true},
];
function fixture(t, handler, html = '<form><label>Name<input id="name"></label><label>Biography<textarea id="bio"></textarea></label><input id="next"><input type="search" id="search"></form><button id="outside">Outside</button>') {
  const dom = new JSDOM(html, {url: 'https://jobs.example.com/apply', pretendToBeVisual: true});
  const document = dom.window.document;
  const messages = [];
  const inline = createInlineAutofill(document, {describe: descriptorForElement, send: async message => {
    messages.push(message);
    if (handler) return handler(message);
    return {ok: true, sessionId: 's1', requestId: message.requestId, candidates};
  }});
  const field = document.querySelector('#name');
  const host = () => document.querySelector('[data-job-inline-autofill]');
  const root = () => host()?.shadowRoot;
  const button = name => [...root().querySelectorAll('button')].find(node => node.textContent === name);
  const key = (key, options = {}, target = field) => {
    const event = new dom.window.KeyboardEvent('keydown', {key, bubbles: true, composed: true, cancelable: true, ...options});
    target.dispatchEvent(event);
    return event;
  };
  const input = value => { field.value = value; field.dispatchEvent(new dom.window.Event('input', {bubbles: true})); };
  t.after(() => { inline.dispose(); dom.window.close(); });
  return {dom, document, messages, inline, field, host, root, button, key, input};
}

test('ordinary Tab does not accept the first returned answer', async () => {
  const dom = new JSDOM('<label>Name<input id="name"></label><input id="next">',
    {url: 'https://jobs.example.com/apply', pretendToBeVisual: true});
  const document = dom.window.document;
  const messages = [];
  const inline = createInlineAutofill(document, {
    describe: descriptorForElement,
    send: async message => {
      messages.push(message);
      return {ok: true, sessionId: 's1', requestId: message.requestId,
        candidates: [{candidateId: 'c1', answer: 'Synthetic Name',
          sourceQuestion: 'Full name', kind: 'equivalent', requiresApproval: true}]};
    },
  });
  document.querySelector('#name').focus();
  await new Promise(resolve => setTimeout(resolve, 0));
  const event = new dom.window.KeyboardEvent('keydown',
    {key: 'Tab', bubbles: true, cancelable: true});
  document.querySelector('#name').dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  assert.equal(messages.some(m => m.type === 'JOB_INLINE_ACCEPT'), false);
  inline.dispose();
  dom.window.close();
});

test('focus and click coalesce; arrows disclose the complete selection before Tab accepts', async t => {
  const f = fixture(t);
  f.field.focus(); f.field.click(); await tick();
  assert.equal(f.messages.filter(m => m.type === 'JOB_INLINE_QUERY').length, 1);
  assert.equal(f.root().querySelector('[aria-selected="true"]'), null);
  assert.equal(f.key('ArrowDown').defaultPrevented, true);
  f.key('ArrowDown');
  assert.match(f.root().querySelector('[data-preview]').textContent, /Another complete answer\nSecond line/);
  assert.match(f.root().querySelector('[data-preview]').textContent, /Preferred name/);
  assert.equal(f.key('Tab').defaultPrevented, true);
  const accepted = f.messages.find(m => m.type === 'JOB_INLINE_ACCEPT');
  assert.equal(accepted.candidateId, 'c2');
  assert.ok(accepted.acceptanceToken);
  assert.equal(f.field.value, '');
});

test('Shift+Tab, Enter, modifiers and IME keys remain native', async t => {
  const f = fixture(t); f.field.focus(); await tick(); f.key('ArrowDown');
  for (const [key, options] of [['Tab', {shiftKey: true}], ['Enter', {}], ['ArrowDown', {ctrlKey: true}], ['Tab', {altKey: true}], ['ArrowUp', {metaKey: true}], ['Tab', {isComposing: true}]]) {
    assert.equal(f.key(key, options).defaultPrevented, false);
  }
  const bio = f.document.querySelector('#bio'); bio.focus(); await tick();
  assert.equal(f.key('Enter', {}, bio).defaultPrevented, false);
  assert.equal(f.messages.some(m => m.type === 'JOB_INLINE_ACCEPT'), false);
});

test('loading and empty-result Tab navigate without acceptance', async t => {
  let resolve;
  const f = fixture(t, m => m.type === 'JOB_INLINE_QUERY' ? new Promise(r => {resolve = r;}) : {ok: true});
  f.field.focus(); assert.equal(f.key('Tab').defaultPrevented, false);
  resolve({ok: true, sessionId: 's1', requestId: f.messages[0].requestId, candidates: []}); await tick();
  assert.equal(f.key('Tab').defaultPrevented, false);
  assert.equal(f.messages.some(m => m.type === 'JOB_INLINE_ACCEPT'), false);
});

test('mouse selection and Use sends deliberate reviewed acceptance', async t => {
  const f = fixture(t); f.field.focus(); await tick();
  f.root().querySelectorAll('[role="option"]')[1].click();
  f.button('Use and save reviewed answer').click();
  assert.equal(f.messages.find(m => m.type === 'JOB_INLINE_ACCEPT').candidateId, 'c2');
});

test('Use from popup controls returns focus to the field before pending acceptance', async t => {
  const f = pendingAcceptance(t); f.field.focus(); await tick();
  f.key('ArrowDown', {altKey: true}); f.key('ArrowDown', {}, f.root().activeElement);
  const use = f.button('Use and save reviewed answer'); use.focus(); use.click();
  assert.equal(f.document.activeElement, f.field);
  assert.equal(f.inline.beforeFill(f.args()), true);
});

test('popup is an isolated dialog outside the form and preserves site ARIA', async t => {
  const f = fixture(t); f.field.setAttribute('aria-describedby', 'site-description');
  f.field.focus(); await tick();
  assert.equal(f.host().closest('form'), null);
  assert.equal(f.document.querySelector('[role="listbox"]'), null);
  assert.ok(f.root().querySelector('[role="dialog"][aria-label]'));
  assert.ok(f.root().querySelector('[role="listbox"][aria-label]'));
  assert.ok(f.root().querySelector('[role="status"][aria-live="polite"]'));
  assert.equal(f.field.getAttribute('aria-describedby'), 'site-description');
  assert.equal(f.field.getAttribute('role'), null);
  assert.ok([...f.root().querySelectorAll('button')].every(node => node.tabIndex === -1));
  assert.match(f.root().textContent, /Alt\+ArrowDown/);
});

test('Alt+ArrowDown enters popup controls; Escape restores field focus and closes', async t => {
  const f = fixture(t); f.field.focus(); await tick();
  assert.equal(f.key('ArrowDown', {altKey: true}).defaultPrevented, true);
  assert.equal(f.document.activeElement, f.host());
  assert.equal(f.inline.activeField(), f.field);
  assert.ok([...f.root().querySelectorAll('button')].every(node => node.tabIndex === 0));
  const focused = f.root().activeElement;
  assert.equal(f.key('Tab', {}, focused).defaultPrevented, false);
  f.key('Escape', {}, focused);
  assert.equal(f.document.activeElement, f.field);
  assert.equal(f.host().hidden, true);
  assert.equal(f.messages.filter(m => m.type === 'JOB_INLINE_QUERY').length, 1);
});

test('popup focus retains the selected field when application forms have equal scores', async t => {
  const f = fixture(t, null, '<form aria-label="Job application"><label>Name<input id="name"></label></form><form aria-label="Job application"><label>Name<input id="other"></label></form>');
  f.field.focus(); await tick();
  f.key('ArrowDown', {altKey: true});
  assert.equal(f.inline.activeField(), f.field);
  assert.equal(f.document.__jobApplicationInlineFocusAnchor, f.field);
  f.key('Escape', {}, f.root().activeElement);
  assert.equal(f.document.__jobApplicationInlineFocusAnchor, undefined);
  f.field.click(); await tick(); f.key('ArrowDown', {altKey: true});
  f.field.remove(); await tick();
  assert.equal(f.document.__jobApplicationInlineFocusAnchor, undefined);
});

test('Close then clicking the same field reopens the single host', async t => {
  const f = fixture(t); f.field.focus(); await tick();
  f.button('Close').click(); assert.equal(f.host().hidden, true);
  f.field.click(); await tick();
  assert.equal(f.host().hidden, false);
  assert.equal(f.document.querySelectorAll('[data-job-inline-autofill]').length, 1);
  assert.equal(f.messages.filter(m => m.type === 'JOB_INLINE_QUERY').length, 2);
});

function pendingAcceptance(t) {
  const f = fixture(t, m => m.type === 'JOB_INLINE_ACCEPT' ? new Promise(() => {}) : {ok: true, sessionId: 's1', requestId: m.requestId, candidates});
  const args = () => ({element: f.field, field: descriptorForElement(f.document, f.field), decision: {fieldId: descriptorForElement(f.document, f.field)?.id, value: candidates[0].answer}, acceptanceToken: f.messages.find(m => m.type === 'JOB_INLINE_ACCEPT').acceptanceToken});
  return {...f, args};
}

test('acceptance token is one-use, verifies live descriptor and permits ordinary unguarded fills', async t => {
  const f = pendingAcceptance(t); f.field.focus(); await tick(); f.key('ArrowDown'); f.key('Tab');
  assert.equal(f.inline.beforeFill(f.args()), true);
  assert.equal(f.inline.beforeFill(f.args()), false);
  assert.equal(f.inline.beforeFill({}), true);
});

for (const [name, change] of [
  ['second Tab', f => assert.equal(f.key('Tab').defaultPrevented, false)],
  ['typing then erasing', f => {f.input('typed'); f.input('');}],
  ['script value change', f => {f.field.value = 'script';}],
  ['same-node question change', f => {f.field.parentElement.firstChild.textContent = 'Different question';}],
  ['blur to another field', f => f.document.querySelector('#next').focus()],
  ['Escape', f => f.key('Escape')],
  ['composition', f => f.field.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart', {bubbles: true}))],
  ['detachment', f => f.field.remove()],
]) test(`${name} revokes pending acceptance`, async t => {
  const f = pendingAcceptance(t); f.field.focus(); await tick(); f.key('ArrowDown'); f.key('Tab');
  change(f);
  assert.equal(f.inline.beforeFill(f.args()), false);
});

test('nonempty input keeps the answer; erasing starts a new query; autofill events do not query', async t => {
  const f = fixture(t); f.field.value = 'mine'; f.field.focus(); await tick();
  assert.equal(f.messages.filter(m => m.type === 'JOB_INLINE_QUERY').length, 0);
  assert.match(f.root().textContent, /Your answer is kept/);
  assert.equal(f.root().querySelectorAll('[role="option"]').length, 0);
  assert.equal(f.button('Generate answer').hidden, true);
  assert.equal(f.button('Edit in panel').hidden, true);
  assert.equal(f.dom.window.getComputedStyle(f.root().querySelector('small[hidden]')).display, 'none');
  f.input(''); await tick();
  assert.equal(f.messages.filter(m => m.type === 'JOB_INLINE_QUERY').length, 1);
  f.document.__jobApplicationFilling = true; f.input('generated'); f.document.__jobApplicationFilling = false;
  assert.equal(f.messages.filter(m => m.type === 'JOB_INLINE_QUERY').length, 1);
});

test('out-of-order A to B replies and replaced elements never display stale answers', async t => {
  const pending = [];
  const f = fixture(t, m => m.type === 'JOB_INLINE_QUERY' ? new Promise(resolve => pending.push({m, resolve})) : {ok: true});
  f.field.focus(); f.document.querySelector('#bio').focus();
  pending[1].resolve({ok: true, sessionId: 'b', requestId: pending[1].m.requestId, candidates: [{...candidates[0], answer: 'B answer'}]}); await tick();
  pending[0].resolve({ok: true, sessionId: 'a', requestId: pending[0].m.requestId, candidates: [{...candidates[0], answer: 'A answer'}]}); await tick();
  assert.match(f.root().textContent, /B answer/); assert.doesNotMatch(f.root().textContent, /A answer/);
  const bio = f.document.querySelector('#bio'); bio.replaceWith(bio.cloneNode(true)); await tick();
  assert.equal(f.host().hidden, true); assert.equal(f.inline.activeField(), null);
});

test('typing then erasing during a pending query rejects the old revision', async t => {
  const pending = [];
  const f = fixture(t, m => m.type === 'JOB_INLINE_QUERY' ? new Promise(resolve => pending.push({m, resolve})) : {ok: true});
  f.field.focus(); f.input('x'); f.input('');
  pending[0].resolve({ok: true, sessionId: 'old', requestId: pending[0].m.requestId, candidates}); await tick();
  assert.equal(f.root().querySelectorAll('[role="option"]').length, 0);
  pending[1].resolve({ok: true, sessionId: 'new', requestId: pending[1].m.requestId, candidates}); await tick();
  assert.equal(f.root().querySelectorAll('[role="option"]').length, 2);
});

test('composition, unsupported focus, outside interaction and pagehide dismiss the popup', async t => {
  const f = fixture(t); f.field.focus(); await tick();
  f.field.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart', {bubbles: true}));
  assert.equal(f.host().hidden, true); f.field.click(); assert.equal(f.host().hidden, true);
  f.field.dispatchEvent(new f.dom.window.CompositionEvent('compositionend', {bubbles: true}));
  f.field.click(); await tick(); assert.equal(f.host().hidden, false);
  f.document.querySelector('#search').focus(); assert.equal(f.host().hidden, true);
  f.field.focus(); await tick(); f.document.querySelector('#outside').click(); assert.equal(f.host().hidden, true);
  f.field.click(); await tick(); f.dom.window.dispatchEvent(new f.dom.window.Event('pagehide')); assert.equal(f.host().hidden, true);
});

test('failed queries recover on click and answer markup stays text', async t => {
  let fail = true;
  const markup = '<img src=x onerror=alert(1)><script>evil()</script>';
  const f = fixture(t, m => {
    if (m.type !== 'JOB_INLINE_QUERY') return {ok: true};
    if (fail) {fail = false; throw new Error('Connection unavailable');}
    return {ok: true, sessionId: 's1', requestId: m.requestId, candidates: [{...candidates[0], answer: markup}]};
  });
  f.field.focus(); await tick(); assert.match(f.root().textContent, /Connection unavailable/);
  f.field.click(); await tick(); assert.match(f.root().textContent, /<img src=x/);
  assert.equal(f.root().querySelector('img, script'), null);
});

test('worker error envelopes without request IDs surface locally and allow retry', async t => {
  const f = fixture(t, () => ({ok: false, error: 'Application is busy'}));
  f.field.focus(); await tick();
  assert.match(f.root().textContent, /Application is busy/);
  f.field.click(); await tick();
  assert.equal(f.messages.filter(m => m.type === 'JOB_INLINE_QUERY').length, 2);
});

test('Generate routes only explicit activation and Edit in panel retains the session without cancel', async t => {
  const f = fixture(t); f.field.focus(); await tick();
  assert.equal(f.messages.some(m => m.type === 'JOB_INLINE_GENERATE'), false);
  f.button('Generate answer').click(); await tick();
  assert.equal(f.messages.find(m => m.type === 'JOB_INLINE_GENERATE').sessionId, 's1');
  f.button('Edit in panel').click(); await tick();
  assert.equal(f.messages.find(m => m.type === 'JOB_INLINE_EDIT_IN_PANEL').sessionId, 's1');
  assert.equal(f.messages.some(m => m.type === 'JOB_INLINE_CANCEL'), false);
  assert.equal(f.host().hidden, true);
});

test('coordinates flip and clamp to the frame viewport and update after scroll', async t => {
  const f = fixture(t); let top = 720;
  f.field.getBoundingClientRect = () => ({left: 990, right: 1090, top, bottom: top + 30, width: 100, height: 30});
  f.field.focus(); await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(parseFloat(f.host().style.left) + parseFloat(f.host().style.width) <= f.dom.window.innerWidth);
  assert.ok(parseFloat(f.host().style.top) < top);
  top = 20; f.document.dispatchEvent(new f.dom.window.Event('scroll')); await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(parseFloat(f.host().style.top), 56);
});
