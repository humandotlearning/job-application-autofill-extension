import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PHOENIX = 'http://127.0.0.1:6006/v1/projects/job-autofill/spans';

export async function fetchSessionSpans(sessionId, {fetchImpl = fetch, endpoint = PHOENIX} = {}) {
  if (!sessionId) return [];
  const spans = [];
  const cursors = new Set();
  let cursor = '';
  while (true) {
    const url = new URL(endpoint);
    url.searchParams.set('limit', '50');
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetchImpl(url, {signal: AbortSignal.timeout(15_000)});
    if (!response.ok) throw new Error(`Phoenix returned HTTP ${response.status}`);
    const page = await response.json();
    if (!Array.isArray(page.data)) throw new Error('Phoenix returned an invalid spans page');
    spans.push(...page.data.filter(span => span.attributes?.['session.id'] === sessionId));
    if (!page.next_cursor) break;
    if (cursors.has(page.next_cursor)) throw new Error('Phoenix repeated a pagination cursor');
    cursors.add(page.next_cursor);
    cursor = page.next_cursor;
  }
  return spans.sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
}

export function prepareFixture(capture) {
  if (capture?.schemaVersion !== 1 || typeof capture.snapshot?.html !== 'string'
    || !Array.isArray(capture.snapshot?.inspection?.fields)) throw new Error('Unsupported debug case file');
  return {
    schemaVersion: 1,
    hostname: capture.site?.hostname || '',
    html: capture.snapshot.html,
    expected: capture.snapshot.inspection,
    limitations: capture.snapshot.limitations || {},
  };
}

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/export-debug-case.mjs <capture.json>');
  const capture = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'));
  const fixture = prepareFixture(capture);
  const id = `${String(capture.capturedAt || '').replace(/[^0-9]/g, '').slice(0, 17)}-${fixture.hostname.replace(/[^a-z0-9.-]/gi, '-').slice(0, 80) || 'form'}`;
  const directory = join(ROOT, 'logs', 'cases', id);
  await mkdir(directory, {recursive: true});
  await writeFile(join(directory, 'fixture-candidate.json'), JSON.stringify(fixture, null, 2));
  try {
    const spans = await fetchSessionSpans(capture.sessionId);
    await writeFile(join(directory, 'trace.json'), JSON.stringify({sessionId: capture.sessionId, spans}, null, 2));
    console.log(`Saved ${spans.length} Phoenix spans and a fixture candidate to ${directory}`);
    if (!capture.sessionId) console.log('No application session was active; this case has no Phoenix trace.');
    else if (!spans.length) console.log('No spans found for this session. Check tracing settings and pending delivery.');
  } catch (error) {
    console.error(`Fixture candidate saved to ${directory}. Phoenix export failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
