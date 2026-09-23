import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {readdir, readFile} from 'node:fs/promises';
import {captureDebugSnapshot} from '../src/debug-case.js';
import {collectFieldDescriptors, inspectDocument} from '../src/form-engine.js';
import {fetchSessionSpans, prepareFixture} from '../scripts/export-debug-case.mjs';

function rehydrateShadowRoots(document) {
  const roots = [document];
  for (const root of roots) {
    for (const template of root.querySelectorAll('template[shadowrootmode="open"]')) {
      const shadow = template.parentElement.attachShadow({mode: 'open'});
      shadow.append(template.content.cloneNode(true));
      template.remove();
      roots.push(shadow);
    }
  }
}

test('debug snapshot removes entered values and secrets while retaining replayable form structure', () => {
  const dom = new JSDOM(`<main><form aria-label="Job application" action="https://example.test/secret-path">
    <label>Full name<input name="fullName" value="Private Applicant" required></label>
    <label>Message<textarea>Private narrative</textarea></label>
    <input type="hidden" name="csrf" value="hidden-secret"><input type="password" value="password-secret">
    <label>Resume<input type="file" name="resume"></label>
    <div contenteditable="true">Private editable</div>
    <a href="https://example.test/private">Help</a>
    <button type="button" role="combobox" aria-controls="countries" aria-label="Country">Select country</button>
    <button type="submit">Submit application</button>
    <script>window.secret='script-secret'</script>
  </form><div id="countries" role="listbox"><div role="option" data-value="IN">India</div></div></main>`, {url: 'https://example.test/apply'});
  try {
    const host = dom.window.document.createElement('contact-picker');
    dom.window.document.querySelector('form').append(host);
    host.attachShadow({mode: 'open'}).innerHTML = '<label>Email<input type="email" aria-required="true" value="private@example.test"></label>';
    const snapshot = captureDebugSnapshot(dom.window.document);
    const body = JSON.stringify(snapshot);
    for (const secret of ['Private Applicant', 'Private narrative', 'hidden-secret', 'password-secret',
      'Private editable', 'private@example.test', 'script-secret', 'secret-path', 'https://example.test/private']) {
      assert.equal(body.includes(secret), false, secret);
    }
    assert.match(snapshot.html, /shadowrootmode="open"/);
    assert.match(snapshot.html, /type="file"/);
    assert.match(snapshot.html, /data-value="IN"/);
    assert.match(snapshot.html, /Submit application/);
    const fixture = prepareFixture({schemaVersion: 1, site: {hostname: 'example.test'}, snapshot});
    const replay = new JSDOM(`<main>${fixture.html}</main>`, {url: 'https://example.test/apply'});
    try {
      rehydrateShadowRoots(replay.window.document);
      const fields = collectFieldDescriptors(replay.window.document);
      assert.deepEqual(fields.map(field => field.label), fixture.expected.fields.map(field => field.label));
      assert.equal(fields.find(field => field.label === 'Email').required, true);
      assert.deepEqual(fields.find(field => field.label === 'Country').options, fixture.expected.fields.find(field => field.label === 'Country').options);
    } finally { replay.window.close(); }
  } finally { dom.window.close(); }
});

test('Phoenix export follows cursors and returns only one application session', async () => {
  const calls = [];
  const spans = await fetchSessionSpans('7:123', {fetchImpl: async url => {
    calls.push(String(url));
    return Response.json(calls.length === 1 ? {
      data: [{start_time: '2026-01-02', attributes: {'session.id': 'other'}},
        {start_time: '2026-01-03', attributes: {'session.id': '7:123'}}], next_cursor: 'next-page',
    } : {data: [{start_time: '2026-01-01', attributes: {'session.id': '7:123'}}], next_cursor: null});
  }});
  assert.equal(spans.length, 2);
  assert.deepEqual(spans.map(span => span.start_time), ['2026-01-01', '2026-01-03']);
  assert.match(calls[1], /cursor=next-page/);
  assert.deepEqual(await fetchSessionSpans(null, {fetchImpl: () => { throw new Error('should not fetch'); }}), []);
});

test('reviewed real-form fixture candidates replay their field and action descriptors', async t => {
  const directory = new URL('./fixtures/real/', import.meta.url);
  const files = (await readdir(directory)).filter(name => name.endsWith('.json'));
  for (const name of files) await t.test(name, async () => {
    const fixture = JSON.parse(await readFile(new URL(name, directory), 'utf8'));
    const dom = new JSDOM(`<main>${fixture.html}</main>`, {url: `https://${fixture.hostname}/apply`});
    try {
      rehydrateShadowRoots(dom.window.document);
      const inspection = inspectDocument(dom.window.document);
      const fieldShape = field => ({label: field.label, type: field.type, required: field.required,
        options: field.options, widget: field.widget || '', section: field.section || '',
        helpText: field.helpText || '', placeholder: field.placeholder || '', constraints: field.constraints || {}});
      const actionShape = action => ({label: action.label, kind: action.kind, type: action.type});
      assert.deepEqual(inspection.fields.map(fieldShape), fixture.expected.fields);
      assert.deepEqual(inspection.actions.map(actionShape), fixture.expected.actions);
    } finally { dom.window.close(); }
  });
});
