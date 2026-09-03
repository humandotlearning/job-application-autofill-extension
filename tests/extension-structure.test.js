import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), 'utf8'));
}

test('manifest is a least-privilege Manifest V3 side-panel extension', async () => {
  const manifest = await readJson('manifest.json');
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
  assert.ok(manifest.permissions.includes('activeTab'));
  assert.ok(manifest.permissions.includes('scripting'));
  assert.ok(manifest.permissions.includes('storage'));
  assert.ok(manifest.permissions.includes('sidePanel'));
  assert.ok(manifest.permissions.includes('identity'));
  assert.ok(manifest.oauth2.scopes.includes('https://www.googleapis.com/auth/spreadsheets.readonly'));
  assert.ok(!manifest.host_permissions.includes('<all_urls>'));
  assert.deepEqual(manifest.host_permissions, [
    'https://docs.google.com/*',
    'https://sheets.googleapis.com/*',
    'https://jobs.ashbyhq.com/*',
    'https://job-boards.greenhouse.io/*',
    'https://impactxtech.com/*',
    'https://www.impactxtech.com/*',
  ]);
});

test('side panel contains sync, scan, and bulk-fill controls', async () => {
  const html = await readFile(new URL('sidepanel.html', root), 'utf8');
  assert.match(html, /id="sync-sheet"/);
  assert.match(html, /id="scan-form"/);
  assert.match(html, /id="fill-form"/);
  assert.match(html, /id="csv-file"/);
  assert.match(html, /id="start-learning"/);
  assert.match(html, /id="approve-learned"/);
  assert.doesNotMatch(html, /id="submit-application"/);
});

test('the provided Google Sheet is the initial data source', async () => {
  const source = await readFile(new URL('src/sidepanel.js', root), 'utf8');
  assert.match(source, /1SoKWd8RL1YpZxP3Bvs5bclF_fhs47VZpk1wh6H6UBJ0/);
});

test('build tooling produces a classic content-script bundle', async () => {
  const source = await readFile(new URL('scripts/build.mjs', root), 'utf8');
  assert.match(source, /dist\/content\.js/);
  assert.match(source, /replace/);
});
