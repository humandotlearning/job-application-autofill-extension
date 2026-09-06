import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), 'utf8'));
}

test('manifest has only the permissions needed for local autofill', async () => {
  const manifest = await readJson('manifest.json');
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'scripting', 'sidePanel', 'storage'].sort());
  assert.equal(manifest.permissions.includes('identity'), false);
  assert.equal('oauth2' in manifest, false);
  assert.ok(manifest.host_permissions.includes('<all_urls>'));
});

test('manifest loads the content script before the side panel starts a run', async () => {
  const manifest = await readJson('manifest.json');
  assert.deepEqual(manifest.content_scripts, [{
    matches: ['<all_urls>'],
    js: ['dist/content.js'],
    all_frames: true,
    run_at: 'document_idle',
  }]);
});

test('side panel contains the guided workflow, review groups, and settings controls', async () => {
  const html = await readFile(new URL('sidepanel.html', root), 'utf8');
  assert.match(html, /id="openai-api-key"/);
  assert.match(html, /id="openai-model"/);
  assert.match(html, /id="auto-advance-pages"/);
  assert.match(html, /id="export-datasource"/);
  assert.match(html, /id="import-datasource-button"/);
  assert.match(html, /id="import-datasource"/);
  assert.match(html, /id="primary-action"/);
  assert.match(html, /id="check-page"/);
  assert.match(html, /id="advance-page"/);
  assert.match(html, /id="save-answers"/);
  assert.match(html, /id="action-required-list"/);
  assert.match(html, /id="review-list"/);
  assert.match(html, /id="optional-list"/);
  assert.match(html, /id="audit-list"/);
  assert.doesNotMatch(html, /Confirm & submit/i);
  for (const id of ['sync-sheet', 'scan-form', 'fill-form', 'csv-file', 'start-learning', 'approve-learned', 'overwrite', 'fill-email-template', 'sheet-url']) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`));
  }
});

test('legacy source and pending-learning workflow is absent', async () => {
  const [worker, panel] = await Promise.all([
    readFile(new URL('src/service-worker.js', root), 'utf8'),
    readFile(new URL('src/sidepanel.js', root), 'utf8'),
  ]);
  assert.doesNotMatch(worker, /formSessions|JOB_AUTOFILL_APPROVE_SAFE_LEARNED/);
  assert.doesNotMatch(panel, /Google|CSV|pendingLearnedAnswers|Start learning|overwrite/i);
});

test('the worker owns one run lifecycle and the obsolete source files are deleted', async () => {
  const worker = await readFile(new URL('src/service-worker.js', root), 'utf8');
  assert.match(worker, /JOB_RUN_START/);
  assert.match(worker, /JOB_RUN_CHECK_PAGE/);
  assert.match(worker, /JOB_RUN_ADVANCE_PAGE/);
  assert.match(worker, /JOB_RUN_FOCUS_FIELD/);
  assert.match(worker, /JOB_RUN_SAVE_ANSWERS/);
  assert.doesNotMatch(worker, /JOB_RUN_CONTINUE/);
  assert.doesNotMatch(worker, /JOB_RUN_CONFIRM_SUBMIT/);
  assert.doesNotMatch(worker, /JOB_APP_SUBMIT/);
  assert.match(worker, /applicationRun/);
  await assert.rejects(readFile(new URL('src/data-source.js', root)));
  await assert.rejects(readFile(new URL('examples/answers-template.csv', root)));
});

test('build tooling produces a classic content-script bundle', async () => {
  const source = await readFile(new URL('scripts/build.mjs', root), 'utf8');
  assert.match(source, /dist\/content\.js/);
  assert.match(source, /replace/);
});

test('content script keeps the message channel open for asynchronous widget selection', async () => {
  const [content, engine, bundle] = await Promise.all([
    readFile(new URL('src/content.js', root), 'utf8'),
    readFile(new URL('src/form-engine.js', root), 'utf8'),
    readFile(new URL('dist/content.js', root), 'utf8'),
  ]);
  assert.match(engine, /export async function applyDecisions/);
  assert.match(content, /applyDecisions\(document, message\.decisions \|\| \[\]\)\s*\.then/);
  assert.match(content, /return true;/);
  assert.match(bundle, /CUSTOM_WIDGET_SELECTOR|button\[aria-haspopup="listbox"\]/);
  assert.match(bundle, /unique exact option/);
  assert.doesNotMatch(content, /JOB_APP_SUBMIT|submitDocument/);
  assert.doesNotMatch(engine, /submitDocument|JOB_APP_SUBMIT/);
  assert.doesNotMatch(bundle, /JOB_APP_SUBMIT|submitDocument/);
});

test('side panel script wires grouped results, focus controls, and persisted page settings', async () => {
  const panel = await readFile(new URL('src/sidepanel.js', root), 'utf8');
  assert.match(panel, /actionRequired/);
  assert.match(panel, /optionalUnresolved/);
  assert.match(panel, /reviewRequired/);
  assert.match(panel, /data-field-id/);
  assert.match(panel, /JOB_RUN_FOCUS_FIELD/);
  assert.match(panel, /autoAdvancePages/);
  assert.match(panel, /openaiModel/);
  assert.match(panel, /JOB_RUN_SAVE_ANSWERS/);
  assert.doesNotMatch(panel, /JOB_RUN_CONFIRM_SUBMIT|JOB_RUN_CONTINUE|confirm-submit/i);
  assert.match(panel, /answer-details/);
});
