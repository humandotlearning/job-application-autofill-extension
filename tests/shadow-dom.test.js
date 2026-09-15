import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  applyDecisions, applicationDestination, clearApplicationSelection, clickAction,
  collectAnswerRecords, collectFieldDescriptors, descriptorForElement, focusField,
  inspectDocument, selectApplicationField, selectApplicationRegion, validateDocument, waitForDocumentSettled,
} from '../src/form-engine.js';

function page(t, html = '<main><h1>Job application</h1></main>') {
  const dom = new JSDOM(html, { url: 'https://jobs.example.test/apply', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  return dom.window.document;
}

function shadow(parent, html = '') {
  const host = parent.ownerDocument.createElement('test-component');
  parent.append(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = html;
  return root;
}

function decision(field, value) {
  return { fieldId: field.id, handle: field.handle, action: 'fill', approved: true,
    value, sensitivity: 'safe', confidence: 'high',
    ...(Object.hasOwn(field, 'rawValue') ? { expectedRawValue: field.rawValue, expectedEditRevision: field.editRevision } : {}) };
}

test('discovers nested roots, root-local labels, slotted Next, and ARIA required fields', t => {
  const document = page(t);
  const outer = shadow(document.querySelector('main'), '<section><h2>Contact</h2></section>');
  const inner = shadow(outer.querySelector('section'), '<span id="label">Email</span><input id="email" type="email" aria-labelledby="label" aria-required="true" autocomplete="email">');
  const action = shadow(outer.querySelector('section'), '<button type="button"><slot></slot></button>');
  action.host.textContent = 'Next';
  const inspection = inspectDocument(document);
  assert.deepEqual(inspection.fields.map(f => [f.label, f.required, f.autocomplete]), [['Email', true, 'email']]);
  assert.equal(inspection.discovery.shadowRootCount, 3);
  assert.equal(inspection.actions.find(a => a.kind === 'next')?.label, 'Next');
  assert.equal(validateDocument(document).requiredEmpty.length, 1);
  inner.querySelector('input').value = 'ada@example.test';
  assert.equal(validateDocument(document).ok, true);
});

test('duplicate IDs in sibling roots keep labels, handles, fills, focus, and saved values distinct', async t => {
  const document = page(t);
  const first = shadow(document.querySelector('main'), '<label for="value">First name</label><input id="value">');
  const second = shadow(document.querySelector('main'), '<label for="value">Last name</label><input id="value">');
  const fields = collectFieldDescriptors(document);
  assert.deepEqual(fields.map(f => f.label), ['First name', 'Last name']);
  assert.notEqual(fields[0].id, fields[1].id);
  assert.notEqual(fields[0].handle, fields[1].handle);
  const result = await applyDecisions(document, [decision(fields[1], 'Lovelace')]);
  assert.equal(result.applied.length, 1);
  assert.equal(first.querySelector('input').value, '');
  assert.equal(second.querySelector('input').value, 'Lovelace');
  assert.equal(focusField(document, fields[1].id, fields[1].handle), true);
  assert.equal(second.activeElement, second.querySelector('input'));
  assert.deepEqual(collectAnswerRecords(document).map(r => [r.question, r.answer]), [['Last name', 'Lovelace']]);
});

test('skips hidden hosts, inherited ARIA state, and the extension popup including its shadow tree', t => {
  const document = page(t);
  const main = document.querySelector('main');
  for (const attribute of ['hidden', 'aria-hidden="true"', 'style="display:none"']) {
    const root = shadow(main, '<input aria-label="Hidden name">');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `<div ${attribute}></div>`;
    const hidden = wrapper.firstChild;
    main.append(hidden);
    hidden.append(root.host);
  }
  const popup = shadow(main, '<input aria-label="Extension answer" value="do not learn">');
  popup.host.setAttribute('data-job-inline-autofill', '');
  shadow(main, '<input aria-label="Disabled name" aria-disabled="true"><input aria-label="Read-only name" aria-readonly="true"><input aria-label="First name" value="Ada">');
  assert.deepEqual(collectFieldDescriptors(document).map(f => f.label), ['First name']);
  assert.deepEqual(collectAnswerRecords(document).map(r => r.answer), ['Ada']);
});

test('composed input events reach a framework host and retained state is checked after rendering', async t => {
  const document = page(t);
  const root = shadow(document.querySelector('main'), '<label>Name<input></label>');
  const input = root.querySelector('input');
  const events = [];
  root.host.addEventListener('input', e => { events.push(e.composedPath()[0]); });
  const field = descriptorForElement(document, input);
  const result = await applyDecisions(document, [decision(field, 'Ada')]);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(events, [input]);
  assert.equal(collectAnswerRecords(document)[0].provenance, 'autofill');
});

test('framework rollback and replacement cannot be reported as successful fills', async t => {
  for (const replace of [false, true]) {
    const document = page(t);
    const root = shadow(document.querySelector('main'), '<label>Name<input id="name"></label>');
    const input = root.querySelector('input');
    root.host.addEventListener('input', () => document.defaultView.setTimeout(() => {
      if (replace) input.replaceWith(input.cloneNode());
      else input.value = '';
    }, 20), { once: true });
    const result = await applyDecisions(document, [decision(descriptorForElement(document, input), 'Ada')]);
    assert.equal(result.applied.length, 0, replace ? 'replaced control' : 'rolled-back value');
    assert.equal(result.failed.length, 1);
  }
});

test('manual shadow input edits invalidate stale decisions and are captured as user answers', async t => {
  const document = page(t);
  const root = shadow(document.querySelector('main'), '<label>Name<input id="name"></label>');
  const input = root.querySelector('input');
  const stale = decision(descriptorForElement(document, input), 'Ada');
  input.value = 'User choice';
  for (const type of ['input', 'change']) input.dispatchEvent(new document.defaultView.Event(type, { bubbles: true, composed: true }));
  assert.equal(descriptorForElement(document, input).editRevision, 2);
  const result = await applyDecisions(document, [stale]);
  assert.equal(result.applied.length, 0);
  assert.equal(input.value, 'User choice');
  const record = collectAnswerRecords(document)[0];
  assert.equal(record.provenance, 'user');
  assert.equal(record.completed, true);
});

test('ARIA invalid state remains unresolved after a successful native write', async t => {
  const document = page(t);
  const root = shadow(document.querySelector('main'), '<input aria-label="Email" type="email">');
  const input = root.querySelector('input');
  root.host.addEventListener('input', () => document.defaultView.setTimeout(() => input.setAttribute('aria-invalid', 'true'), 20));
  const result = await applyDecisions(document, [decision(descriptorForElement(document, input), 'ada@example.test')]);
  assert.equal(result.applied.length, 0);
  assert.equal(validateDocument(document).invalid.length, 1);
  assert.equal(collectAnswerRecords(document).length, 0);
});

test('application region selection ignores newsletter and search forms even under a search title', t => {
  const document = page(t, '<title>Search jobs and alerts</title><form aria-label="Newsletter"><input aria-label="Email"><button>Subscribe</button></form><form role="search"><input type="search"></form><form aria-label="Job application"><input aria-label="First name"><button type="button">Next</button></form>');
  assert.deepEqual(inspectDocument(document).fields.map(f => f.label), ['First name']);
  assert.equal(inspectDocument(document).discovery.code, 'ready');
});

test('ambiguous forms require selection and removing the selected region invalidates it', t => {
  const document = page(t, '<form aria-label="Job application"><input aria-label="First name"></form><form aria-label="Candidate profile"><input aria-label="Last name"></form>');
  assert.equal(inspectDocument(document).discovery.code, 'ambiguous_form');
  assert.equal(collectFieldDescriptors(document).length, 0);
  const chosen = document.querySelectorAll('input')[1];
  const selected = selectApplicationRegion(document, chosen);
  assert.ok(selected.regionId);
  assert.deepEqual(applicationDestination(document), selected);
  assert.deepEqual(collectFieldDescriptors(document).map(f => f.label), ['Last name']);
  clearApplicationSelection(document);
  assert.equal(inspectDocument(document).discovery.code, 'ambiguous_form');
  selectApplicationRegion(document, chosen);
  chosen.closest('form').remove();
  assert.notEqual(applicationDestination(document).regionId, selected.regionId);
  assert.deepEqual(collectFieldDescriptors(document).map(f => f.label), ['First name']);
});

test('settling discovers delayed open roots and reports continued shadow mutations as a timeout', async t => {
  const document = page(t);
  const main = document.querySelector('main');
  const host = document.createElement('test-late');
  main.append(host);
  document.defaultView.setTimeout(() => {
    host.attachShadow({ mode: 'open' }).innerHTML = '<input aria-label="First name">';
  }, 30);
  const settled = await waitForDocumentSettled(document, { minWaitMs: 100, quietMs: 40, timeoutMs: 400 });
  assert.equal(settled.timedOut, false);
  assert.equal(collectFieldDescriptors(document).length, 1);
  let n = 0;
  const ticker = document.defaultView.setInterval(() => host.shadowRoot.querySelector('input').setAttribute('data-tick', String(++n)), 10);
  const timeout = await waitForDocumentSettled(document, { minWaitMs: 50, quietMs: 60, timeoutMs: 140 });
  document.defaultView.clearInterval(ticker);
  assert.equal(timeout.timedOut, true);
});

test('field-only fallback cannot silently expand to a bulk form destination', async t => {
  const document = page(t, '<form aria-label="Newsletter"><input aria-label="Email"></form><form aria-label="Job application"><input aria-label="First name"></form>');
  const input = document.querySelector('input');
  assert.equal(selectApplicationRegion(document, input), null);
  assert.equal(selectApplicationField(document, input).regionId, null);
  assert.equal(applicationDestination(document).regionId, null);
  assert.deepEqual(collectFieldDescriptors(document).map(f => f.label), ['Email']);
  const result = await applyDecisions(document, [decision(descriptorForElement(document, input), 'ada@example.test')]);
  assert.equal(result.applied.length, 1);
  assert.equal(document.querySelectorAll('input')[1].value, '');
  clearApplicationSelection(document);
  assert.deepEqual(collectFieldDescriptors(document).map(f => f.label), ['First name']);
});

test('navigation invalidates explicit application selection', t => {
  const document = page(t, '<form aria-label="Job application"><input aria-label="First name"></form><form aria-label="Candidate profile"><input aria-label="Last name"></form>');
  const selected = selectApplicationRegion(document, document.querySelector('input'));
  document.defaultView.history.pushState({}, '', '/different-application');
  const snapshot = inspectDocument(document);
  assert.equal(snapshot.discovery.code, 'ambiguous_form');
  assert.notEqual(snapshot.destination.documentId, selected.documentId);
  assert.equal(snapshot.fields.length, 0);
});

test('shadow combobox requires an option commit while unrelated text fields can still fill', async t => {
  const document = page(t);
  const root = shadow(document.querySelector('main'), '<input aria-label="First name"><button type="button" role="combobox" aria-label="Country" aria-controls="options">Select one</button><div id="options" role="listbox"><div role="option">India</div></div>');
  const button = root.querySelector('button');
  root.querySelector('[role="option"]').onclick = () => { button.textContent = 'India'; };
  const fields = collectFieldDescriptors(document);
  const result = await applyDecisions(document, fields.map(f => decision(f, f.label === 'Country' ? 'India' : 'Ada')));
  assert.equal(result.applied.length, 2);
  assert.equal(button.textContent, 'India');
  button.textContent = 'Select one';
  root.querySelector('[role="option"]').onclick = () => {};
  const rejected = await applyDecisions(document, [decision(collectFieldDescriptors(document).find(f => f.label === 'Country'), 'India')]);
  assert.equal(rejected.applied.length, 0);
  assert.equal(rejected.unresolved.length, 1);
  assert.equal(root.querySelector('input').value, 'Ada');
});

test('only slotted Next may be activated; final submission is always rejected', t => {
  const document = page(t);
  const next = shadow(document.querySelector('main'), '<button type="button"><slot></slot></button>');
  const final = shadow(document.querySelector('main'), '<button type="button"><slot></slot></button>');
  next.host.textContent = 'Next';
  final.host.textContent = 'Submit application';
  let nextClicks = 0, finalClicks = 0;
  next.querySelector('button').onclick = () => nextClicks++;
  final.querySelector('button').onclick = () => finalClicks++;
  const actions = inspectDocument(document).actions;
  assert.equal(clickAction(document, actions.find(a => a.kind === 'next').id).ok, true);
  assert.equal(clickAction(document, actions.find(a => a.kind === 'submit').id).ok, false);
  assert.equal(nextClicks, 1);
  assert.equal(finalClicks, 0);
});

test('unslotted light controls hidden by a host shadow root are never discovered or saved', t => {
  const document = page(t);
  const root = shadow(document.querySelector('main'), '<input aria-label="First name">');
  root.host.innerHTML = '<input aria-label="Hidden last name" value="Invisible"><button>Submit application</button>';
  const inspection = inspectDocument(document);
  assert.deepEqual(inspection.fields.map(f => f.label), ['First name']);
  assert.equal(inspection.actions.length, 0);
  assert.equal(collectAnswerRecords(document).length, 0);
  assert.equal(descriptorForElement(document, root.host.querySelector('input')), null);
});

test('native and custom controls sharing an ID across roots remain independently addressable', async t => {
  const document = page(t);
  const native = shadow(document.querySelector('main'), '<label for="answer">First name</label><input id="answer">');
  const custom = shadow(document.querySelector('main'), '<button id="answer" type="button" role="combobox" aria-label="Country" aria-controls="countries">Select one</button><div id="countries" role="listbox"><div role="option">India</div></div>');
  custom.querySelector('[role="option"]').onclick = () => { custom.querySelector('button').textContent = 'India'; };
  const fields = collectFieldDescriptors(document);
  assert.deepEqual(fields.map(f => f.label), ['First name', 'Country']);
  assert.notEqual(fields[0].id, fields[1].id);
  assert.notEqual(fields[0].handle, fields[1].handle);
  const result = await applyDecisions(document, [decision(fields[1], 'India')]);
  assert.equal(result.applied.length, 1);
  assert.equal(custom.querySelector('button').textContent, 'India');
  assert.equal(native.querySelector('input').value, '');
});

test('selecting a nested accessible form chooses the nearest region and leaves outer fields untouched', async t => {
  const document = page(t, '<form aria-label="Job application"><input aria-label="First name"><section role="form" aria-label="Candidate contact"><input aria-label="Email" type="email"></section></form>');
  const outer = document.querySelector('input');
  const inner = document.querySelector('section input');
  assert.equal(inspectDocument(document).discovery.code, 'ambiguous_form');
  const selected = selectApplicationRegion(document, inner);
  assert.ok(selected.regionId);
  assert.deepEqual(collectFieldDescriptors(document).map(f => f.label), ['Email']);
  const result = await applyDecisions(document, [decision(descriptorForElement(document, inner), 'ada@example.test')]);
  assert.equal(result.applied.length, 1);
  assert.equal(inner.value, 'ada@example.test');
  assert.equal(outer.value, '');
});

test('an unnamed newsletter form is excluded using its heading and Subscribe action', t => {
  const document = page(t, '<form><h2>Newsletter</h2><label>Email<input type="email"></label><button>Subscribe</button></form><form><h2>Job application</h2><label>First name<input></label><button type="button">Next</button></form>');
  const inspection = inspectDocument(document);
  assert.equal(inspection.discovery.code, 'ready');
  assert.equal(inspection.discovery.regionCount, 1);
  assert.deepEqual(inspection.fields.map(f => f.label), ['First name']);
  assert.deepEqual(inspection.actions.map(a => a.label), ['Next']);
});

test('clicking a container cannot choose one of several ambiguous forms', t => {
  const document = page(t, '<main><form aria-label="Job application"><input aria-label="First name"></form><form aria-label="Candidate profile"><input aria-label="Last name"></form></main>');
  assert.equal(inspectDocument(document).discovery.code, 'ambiguous_form');
  for (const container of [document.body, document.querySelector('main'), document.querySelector('form')]) {
    assert.equal(selectApplicationRegion(document, container), null);
    assert.equal(inspectDocument(document).discovery.code, 'ambiguous_form');
    assert.equal(collectFieldDescriptors(document).length, 0);
  }
});

test('assigned slot controls hide fallback controls from inspection and answer capture', t => {
  const document = page(t);
  const root = shadow(document.querySelector('main'), '<slot name="answer"><input aria-label="Fallback name" value="Hidden answer"></slot>');
  root.host.innerHTML = '<input slot="answer" aria-label="First name" value="Ada">';
  assert.deepEqual(collectFieldDescriptors(document).map(f => f.label), ['First name']);
  assert.deepEqual(collectAnswerRecords(document).map(r => r.answer), ['Ada']);
  assert.equal(descriptorForElement(document, root.querySelector('input')), null);
  root.host.querySelector('input').remove();
  assert.deepEqual(collectFieldDescriptors(document).map(f => f.label), ['Fallback name']);
});
