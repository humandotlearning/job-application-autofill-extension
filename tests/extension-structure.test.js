import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const root = new URL('../', import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), 'utf8'));
}

test('manifest has only the permissions needed for local autofill', async () => {
  const manifest = await readJson('manifest.json');
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, '114');
  assert.equal(manifest.version, '0.1.4');
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
  assert.match(html, /id="fireworks-api-key"/);
  assert.match(html, /id="ai-provider"/);
  assert.match(html, /id="ai-model"/);
  assert.match(html, /accounts\/fireworks\/models\/glm-5p3-flash/);
  assert.match(html, /id="auto-advance-pages"/);
  assert.match(html, /id="export-datasource"/);
  assert.match(html, /id="import-datasource-button"/);
  assert.match(html, /id="import-datasource"/);
  assert.match(html, /id="primary-action"/);
  assert.match(html, /id="check-page"/);
  assert.match(html, /id="advance-page"/);
  assert.match(html, /id="save-answers"/);
  assert.match(html, /id="action-required-list"/);
  assert.match(html, /id="inline-field-card"[^>]*hidden/);
  assert.match(html, /Selected field/);
  assert.match(html, /id="close-inline-field"/);
  assert.match(html, /id="inline-field-list"/);
  assert.match(html, /id="review-list"/);
  assert.match(html, /id="optional-list"/);
  assert.match(html, /id="audit-list"/);
  assert.doesNotMatch(html, /Confirm & submit/i);
  for (const id of ['sync-sheet', 'scan-form', 'fill-form', 'csv-file', 'start-learning', 'approve-learned', 'overwrite', 'fill-email-template', 'sheet-url']) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`));
  }
});

test('side panel exposes a themeable terminal UI token layer', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('sidepanel.html', root), 'utf8'),
    readFile(new URL('src/sidepanel.css', root), 'utf8'),
  ]);
  assert.match(html, /class="app-shell"/);
  assert.match(html, /class="brand-row"/);
  assert.match(html, /GUIDED COPILOT/);
  for (const token of ['--color-bg', '--color-surface', '--color-surface-raised', '--color-text', '--color-text-muted', '--color-border', '--color-accent', '--color-accent-soft', '--color-focus', '--color-ok', '--color-warning', '--color-danger', '--font-mono', '--line-body', '--line-copy', '--border-width', '--focus-width', '--radius-control', '--size-prompt-textarea']) {
    assert.match(css, new RegExp(`${token}:`));
  }
  assert.match(css, /\.app-shell/);
  assert.match(css, /\.brand-row/);
  assert.match(css, /\.pill\s*\{/);
  assert.match(css, /outline:\s*var\(--focus-width\) solid var\(--color-focus\)/);
  assert.match(css, /\.answer-send::before/);
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

test('inline autofill fixture covers supported and intentionally excluded application controls', async () => {
  const html = await readFile(new URL('tests/fixtures/inline-autofill.html', root), 'utf8');
  const parent = new JSDOM(html, {
    url: 'http://127.0.0.1:8765/tests/fixtures/inline-autofill.html',
    runScripts: 'dangerously',
  });
  const {document} = parent.window;
  assert.ok(document.querySelector('form[aria-label="Synthetic job application"]'));
  for (const id of ['full-name', 'email', 'motivation', 'prefilled', 'whitespace-only', 'disabled', 'readonly', 'password', 'search', 'resume', 'work-authorisation', 'location']) {
    assert.ok(document.getElementById(id), `fixture includes ${id}`);
  }
  assert.equal(document.querySelector('#work-authorisation').tagName, 'SELECT');
  assert.equal(document.querySelector('#location').getAttribute('role'), 'combobox');
  assert.equal(document.querySelectorAll('iframe[src$="?child=1"]').length, 1);
  document.querySelector('#replace-motivation').click();
  assert.equal(document.querySelector('#motivation').tagName, 'TEXTAREA');
  document.querySelector('#change-motivation-constraints').click();
  assert.equal(document.querySelector('#motivation').required, true);
  assert.equal(document.querySelector('#motivation').minLength, 120);
  parent.window.close();

  const child = new JSDOM(html, {
    url: 'http://127.0.0.1:8765/tests/fixtures/inline-autofill.html?child=1',
    runScripts: 'dangerously',
  });
  assert.equal(child.window.document.querySelectorAll('iframe').length, 0);
  child.window.close();
});

test('README documents deliberate inline review without activating whole-page learning', async () => {
  const readme = await readFile(new URL('README.md', root), 'utf8');
  assert.match(readme, /Inline suggestions/i);
  assert.match(readme, /text inputs and textareas/i);
  assert.match(readme, /no API key/i);
  assert.match(readme, /Generate answer/i);
  assert.match(readme, /ArrowDown.*Tab|Tab.*ArrowDown/i);
  assert.match(readme, /second Tab|next Tab/i);
  assert.match(readme, /Alt\+ArrowDown/i);
  assert.match(readme, /Edit in panel/i);
  assert.match(readme, /standalone inline use does not activate whole-page learning/i);
  assert.match(readme, /saved-candidate approval retains existing reviewed save behavior/i);
  assert.match(readme, /generated draft does not automatically create reusable facts/i);
});

test('content script keeps the message channel open for asynchronous widget selection', async () => {
  const [content, engine, bundle] = await Promise.all([
    readFile(new URL('src/content.js', root), 'utf8'),
    readFile(new URL('src/form-engine.js', root), 'utf8'),
    readFile(new URL('dist/content.js', root), 'utf8'),
  ]);
  assert.match(engine, /export async function applyDecisions/);
  assert.match(content, /applyDecisions\(document, message\.decisions \|\| \[\], \{deadline: message\.deadline \?\? Infinity,\s*beforeFill: args => inline\.beforeFill\(\{\.\.\.args, acceptanceToken: message\.approvalGuard\?\.acceptanceToken\}\)\}\)\s*\.then/);
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
  assert.match(panel, /fireworksApiKey/);
  assert.match(panel, /aiProvider/);
  assert.match(panel, /aiModel/);
  assert.match(panel, /JOB_RUN_SAVE_ANSWERS/);
  assert.doesNotMatch(panel, /JOB_RUN_CONFIRM_SUBMIT|JOB_RUN_CONTINUE|confirm-submit/i);
  assert.match(panel, /answer-details/);
});
