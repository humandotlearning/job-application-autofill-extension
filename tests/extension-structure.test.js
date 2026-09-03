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

test('side panel contains only the key, run, review, and submit controls', async () => {
  const html = await readFile(new URL('sidepanel.html', root), 'utf8');
  assert.match(html, /id="openai-api-key"/);
  assert.match(html, /id="run-form"/);
  assert.match(html, /id="confirm-submit"/);
  assert.match(html, /id="review-list"/);
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
  assert.match(worker, /JOB_RUN_CONTINUE/);
  assert.match(worker, /JOB_RUN_CONFIRM_SUBMIT/);
  assert.match(worker, /applicationRun/);
  await assert.rejects(readFile(new URL('src/data-source.js', root)));
  await assert.rejects(readFile(new URL('examples/answers-template.csv', root)));
});

test('build tooling produces a classic content-script bundle', async () => {
  const source = await readFile(new URL('scripts/build.mjs', root), 'utf8');
  assert.match(source, /dist\/content\.js/);
  assert.match(source, /replace/);
});
