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

test('generated rows show draft provenance and missing context and require selection before acceptance', async t => {
  const draft = {candidateId: 'generated:1', answer: 'Generated answer', kind: 'generated', requiresApproval: false, evidenceKeys: ['profile:experience']};
  let finish;
  const f = fixture(t, message => message.type === 'JOB_INLINE_GENERATE'
    ? new Promise(resolve => {finish = () => resolve({ok: true, sessionId: 's1', requestId: message.requestId, candidates: [...candidates, draft], generatedSuggestion: {missingContext: 'Add the job description.'}});})
    : {ok: true, sessionId: 's1', requestId: message.requestId, candidates});
  f.field.focus(); await tick();
  f.button('Generate answer').click();
  assert.match(f.root().textContent, /Generating an answer/);
  finish(); await tick();
  assert.equal(f.root().querySelectorAll('[role="option"]').length, 3);
  assert.match(f.root().textContent, /Draft/);
  assert.match(f.root().textContent, /profile:experience/);
  assert.match(f.root().textContent, /Add the job description/);
  assert.equal(f.button('Edit and use').hidden, false);
  assert.equal(f.key('Tab').defaultPrevented, false);
  f.root().querySelectorAll('[role="option"]')[2].click();
  f.button('Use draft').click();
  assert.equal(f.messages.find(message => message.type === 'JOB_INLINE_ACCEPT').candidateId, draft.candidateId);
});

test('popup searches saved answers from the current question and keeps dismissal outside the popup', async t => {
  const f = fixture(t);
  f.field.focus(); await tick();
  const search = f.root().querySelector('[data-search]');
  assert.equal(search.getAttribute('aria-label'), 'Search previous answers');
  assert.equal(f.button('Close'), undefined);
  search.value = 'linkedin';
  search.dispatchEvent(new f.dom.window.Event('input', {bubbles: true, composed: true}));
  await new Promise(resolve => setTimeout(resolve, 250));
  const request = f.messages.find(message => message.type === 'JOB_INLINE_SEARCH');
  assert.equal(request.query, 'linkedin');
  assert.equal(request.sessionId, 's1');
  assert.equal(f.root().querySelectorAll('[role="option"]').length, candidates.length);
});

test('saved-answer matching is explicit and keeps local results and selection while it runs', async t => {
  let finishSemantic;
  const semantic = {candidateId: 'semantic:1', answer: 'A directly reusable saved answer.',
    sourceQuestion: 'Equivalent saved question', kind: 'semantic', requiresApproval: true};
  const f = fixture(t, message => message.type === 'JOB_INLINE_SEMANTIC_SEARCH'
    ? new Promise(resolve => { finishSemantic = () => resolve({ok: true, sessionId: 's1', requestId: message.requestId,
      semanticStatus: 'matched', candidates: [semantic, ...candidates]}); })
    : {ok: true, sessionId: 's1', requestId: message.requestId, candidates});
  f.field.focus(); await tick();
  assert.equal(f.messages.some(message => message.type === 'JOB_INLINE_SEMANTIC_SEARCH'), false,
    'ordinary focus stays local');
  f.root().querySelectorAll('[role="option"]')[1].click();
  const selectedId = f.root().querySelector('[aria-selected="true"]').id;
  f.button('Find saved answer').click();
  assert.equal(f.root().querySelectorAll('[role="option"]').length, candidates.length,
    'local results remain visible while matching runs');
  assert.equal(f.root().querySelector('[aria-selected="true"]').id, selectedId);
  assert.match(f.root().querySelector('[role="status"]').textContent, /Searching saved answers/);
  finishSemantic(); await tick();
  assert.equal(f.root().querySelectorAll('[role="option"]').length, 3);
  assert.equal(f.root().querySelector('[aria-selected="true"]').textContent.includes(candidates[1].answer), true);
  assert.match(f.root().querySelector('[role="status"]').textContent, /Saved answer found/);
});

test('busy acceptance keeps the selected answer available for explicit retry', async t => {
  const f = fixture(t, message => message.type === 'JOB_INLINE_ACCEPT'
    ? {ok: false, error: 'Fill is in progress'}
    : {ok: true, sessionId: 's1', requestId: message.requestId, candidates});
  f.field.focus(); await tick(); f.key('ArrowDown'); f.key('Tab'); await tick();
  assert.match(f.root().textContent, /Fill is in progress/);
  assert.equal(f.root().querySelectorAll('[role="option"]').length, 2);
  assert.equal(f.button('Use and save reviewed answer').disabled, false);
});

test('search serializes requests, invalidates selection during debounce, and ignores obsolete replies', async t => {
  const pending = [];
  const f = fixture(t, message => message.type === 'JOB_INLINE_SEARCH'
    ? new Promise(resolve => pending.push({message, resolve}))
    : {ok: true, sessionId: 's1', requestId: message.requestId, candidates});
  f.field.focus(); await tick(); f.key('ArrowDown');
  f.key('ArrowDown', {altKey: true});
  const search = f.root().querySelector('[data-search]');
  const type = value => {search.value = value; search.dispatchEvent(new f.dom.window.Event('input', {bubbles: true, composed: true}));};
  type('first');
  assert.equal(f.root().querySelectorAll('[role=option]').length, 0);
  assert.equal(f.button('Use and save reviewed answer').disabled, true);
  await new Promise(resolve => setTimeout(resolve, 230));
  type('second'); await new Promise(resolve => setTimeout(resolve, 230));
  assert.equal(pending.length, 1);
  pending[0].resolve({ok: true, sessionId: 's1', requestId: pending[0].message.requestId, candidates}); await tick();
  assert.equal(f.root().querySelectorAll('[role=option]').length, 0);
  assert.equal(pending.length, 2);
  assert.equal(pending[1].message.query, 'second');
  pending[1].resolve({ok: true, sessionId: 's1', requestId: pending[1].message.requestId, candidates: [{...candidates[0], candidateId: 'fresh'}]}); await tick();
  f.key('ArrowDown', {}, search);
  assert.equal(f.root().activeElement.getAttribute('role'), 'listbox');
  assert.equal(f.field.value, '');
  f.button('Use and save reviewed answer').click();
  assert.equal(f.messages.find(message => message.type === 'JOB_INLINE_ACCEPT').candidateId, 'fresh');
});

test('search preserves early typing, supports IME, retries errors, and reloads empty queries', async t => {
  let finishQuery, fail = true;
  const f = fixture(t, message => message.type === 'JOB_INLINE_QUERY'
    ? new Promise(resolve => {finishQuery = () => resolve({ok: true, sessionId: 's1', requestId: message.requestId, candidates});})
    : message.type === 'JOB_INLINE_SEARCH' && fail ? {ok: false, error: 'Temporary search failure'}
      : {ok: true, sessionId: 's1', requestId: message.requestId, candidates});
  f.field.focus(); f.key('ArrowDown', {altKey: true});
  const search = f.root().querySelector('[data-search]');
  search.value = 'early'; search.dispatchEvent(new f.dom.window.Event('input', {bubbles: true, composed: true}));
  finishQuery(); await tick();
  assert.equal(search.value, 'early');
  await new Promise(resolve => setTimeout(resolve, 230));
  assert.equal(f.button('Retry search').hidden, false);
  fail = false; f.button('Retry search').click(); await new Promise(resolve => setTimeout(resolve, 230));
  assert.equal(f.root().querySelectorAll('[role=option]').length, 2);
  search.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart', {bubbles: true, composed: true}));
  assert.equal(f.host().hidden, false);
  search.value = '';
  search.dispatchEvent(new f.dom.window.CompositionEvent('compositionend', {bubbles: true, composed: true}));
  await new Promise(resolve => setTimeout(resolve, 230));
  assert.equal(f.messages.filter(message => message.type === 'JOB_INLINE_SEARCH').at(-1).query, '');
  f.key('Escape', {}, search);
  assert.equal(f.host().hidden, true);
});

test('busy generation and provider errors retain saved choices and busy selection', async t => {
  let error = 'Fill is in progress';
  const f = fixture(t, message => message.type === 'JOB_INLINE_GENERATE'
    ? {ok: false, error}
    : {ok: true, sessionId: 's1', requestId: message.requestId, candidates});
  f.field.focus(); await tick(); f.key('ArrowDown');
  f.button('Generate answer').click(); await tick();
  assert.equal(f.root().querySelector('[aria-selected="true"]')?.id, 'inline-answer-0');
  error = 'Add an API key';
  f.button('Generate answer').click(); await tick();
  assert.equal(f.root().querySelectorAll('[role="option"]').length, 2);
  assert.match(f.root().textContent, /Add an API key/);
  f.key('ArrowDown');
  assert.equal(f.button('Use and save reviewed answer').disabled, false);
});

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

test('long answer review scrolls separately while an inline error stays visible', async t => {
  const longAnswer = 'Full answer. '.repeat(100);
  const error = 'Inline destination changed. Focus an empty field again.';
  const f = fixture(t, message => ({ok: true, sessionId: 's1', requestId: message.requestId,
    candidates: [{...candidates[0], answer: longAnswer}], error}));
  f.field.focus(); await tick();
  const status = f.root().querySelector('[role="status"]');
  const results = f.root().querySelector('[data-results]');
  assert.equal(status.parentElement, results.parentElement);
  assert.equal(results.contains(status), false);
  assert.equal(status.dataset.state, 'error');
  assert.equal(status.textContent, 'This field changed. Click it again to load suggestions.');
  assert.match(f.root().querySelector('style').textContent, /\[data-results\]\s*\{[^}]*overflow-y:\s*auto/);
  f.key('ArrowDown');
  assert.match(f.root().querySelector('[data-preview]').textContent, /Full answer/);
  assert.equal(results.contains(f.button('Use and save reviewed answer')), false);
  assert.equal(f.root().querySelector('[role="dialog"]').getAttribute('aria-label'), 'Application answer suggestions');
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

test('returning from popup controls to the unchanged field restores ordinary Tab order', async t => {
  const f = fixture(t); f.field.focus(); await tick();
  f.key('ArrowDown', {altKey: true});
  const controls = [f.root().querySelector('[role="listbox"]'), f.button('Generate answer'), f.button('Edit and use'), f.root().querySelector('[data-search]')];
  f.button('Generate answer').focus();
  assert.ok(controls.every(control => control.tabIndex === 0), 'focus within the popup preserves normal control Tab order');
  f.field.focus();
  assert.equal(f.host().hidden, false);
  assert.equal(f.root().querySelector('[aria-selected="true"]'), null);
  assert.ok(controls.every(control => control.tabIndex === -1), 'returning to the page removes popup controls from sequential Tab order');
  assert.equal(f.key('Tab').defaultPrevented, false);
  assert.equal(f.document.activeElement, f.field);
  assert.equal(f.root().activeElement, null);
  assert.equal(f.messages.some(message => message.type === 'JOB_INLINE_ACCEPT'), false);
  assert.equal(f.messages.filter(message => message.type === 'JOB_INLINE_QUERY').length, 1);
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

test('Escape then clicking the same field reopens the single host', async t => {
  const f = fixture(t); f.field.focus(); await tick();
  f.key('Escape'); assert.equal(f.host().hidden, true);
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
  assert.equal(f.button('Edit and use').hidden, true);
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

test('Edit and use displays the toolbar fallback without cancelling the handed-off session', async t => {
  const fallback = 'Open the extension toolbar button to continue editing';
  const f = fixture(t, message => message.type === 'JOB_INLINE_EDIT_IN_PANEL'
    ? {ok: true, error: fallback}
    : {ok: true, sessionId: 's1', requestId: message.requestId, candidates});
  f.field.focus(); await tick();
  f.button('Edit and use').click(); await tick();
  assert.equal(f.host().hidden, false);
  assert.equal(f.root().querySelector('[role="status"]').textContent, fallback);
  assert.equal(f.messages.some(message => message.type === 'JOB_INLINE_CANCEL'), false);
});

test('Generate routes only explicit activation and Edit and use retains the session without cancel', async t => {
  const f = fixture(t); f.field.focus(); await tick();
  assert.equal(f.messages.some(m => m.type === 'JOB_INLINE_GENERATE'), false);
  f.button('Generate answer').click(); await tick();
  assert.equal(f.messages.find(m => m.type === 'JOB_INLINE_GENERATE').sessionId, 's1');
  f.button('Edit and use').click(); await tick();
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

test('dropdown search inputs get no inline suggestion and dropdown keys stay on the page', async t => {
  const f = fixture(t, null, '<form><label>Name<input id="name"></label><button type="button" role="combobox" aria-label="Source" aria-expanded="true" aria-controls="source-options">Search</button><div id="source-options" role="listbox"><input id="dropdown-search" type="text"><div role="option">Recruiter</div></div></form>');
  const dropdownSearch = f.document.getElementById('dropdown-search');
  dropdownSearch.focus(); await tick();
  assert.equal(f.host(), null);
  f.field.focus(); await tick();
  assert.equal(f.host().hidden, false);
  const arrow = f.key('ArrowDown', {}, dropdownSearch);
  assert.equal(arrow.defaultPrevented, false);
  dropdownSearch.focus();
  assert.equal(f.host().hidden, true);
});

test('suggestion handle drags and moves by arrow keys within the viewport, then resets', async t => {
  const f = fixture(t); f.field.focus(); await new Promise(resolve => setTimeout(resolve, 25));
  const handle = f.root().querySelector('[data-drag-handle]');
  const initialLeft = parseFloat(f.host().style.left);
  const initialTop = parseFloat(f.host().style.top);
  handle.dispatchEvent(new f.dom.window.MouseEvent('pointerdown', {bubbles: true, composed: true, cancelable: true, button: 0, clientX: 20, clientY: 20}));
  assert.equal(f.host().hidden, false);
  f.dom.window.dispatchEvent(new f.dom.window.MouseEvent('pointermove', {clientX: 120, clientY: 100}));
  assert.ok(parseFloat(f.host().style.left) > initialLeft);
  assert.ok(parseFloat(f.host().style.top) > initialTop);
  f.dom.window.dispatchEvent(new f.dom.window.MouseEvent('pointermove', {clientX: 10000, clientY: 10000}));
  assert.ok(parseFloat(f.host().style.left) + parseFloat(f.host().style.width) <= f.dom.window.innerWidth);
  assert.ok(parseFloat(f.host().style.top) + parseFloat(f.host().style.maxHeight) <= f.dom.window.innerHeight);
  f.dom.window.dispatchEvent(new f.dom.window.MouseEvent('pointerup'));
  const left = parseFloat(f.host().style.left);
  assert.equal(f.key('ArrowLeft', {}, handle).defaultPrevented, true);
  assert.ok(parseFloat(f.host().style.left) < left);
  f.key('Escape', {}, handle);
  f.field.click(); await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(parseFloat(f.host().style.left), initialLeft);
  assert.equal(parseFloat(f.host().style.top), initialTop);
});

test('invalidated extension shows recovery instructions and preserves form entries', async t => {
  const f = fixture(t, () => { throw new Error('Extension context invalidated.'); });
  f.document.querySelector('#bio').value = 'Unsaved application text';
  f.field.focus(); await tick();
  assert.match(f.root().querySelector('[role="status"]').textContent, /open the application in a new tab/);
  assert.equal(f.button('Retry search').hidden, true);
  assert.equal(f.button('Generate answer').disabled, true);
  assert.equal(f.field.value, '');
  assert.equal(f.document.querySelector('#bio').value, 'Unsaved application text');
});
