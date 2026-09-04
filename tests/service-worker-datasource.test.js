import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('seeds an empty datasource once and preserves edits afterward', async () => {
  const localData = { answerRecords: [], coverMessages: [], datasourceMeta: null };
  const sessionData = {};
  const listeners = [];
  let seedLoads = 0;

  globalThis.fetch = async () => {
    seedLoads += 1;
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(await readFile(new URL('../data/seed-data.json', import.meta.url), 'utf8')),
    };
  };
  globalThis.chrome = {
    storage: {
      local: {
        get: async (defaults) => ({ ...defaults, ...localData }),
        set: async (values) => Object.assign(localData, values),
      },
      session: {
        get: async (defaults) => ({ ...defaults, ...sessionData }),
        set: async (values) => Object.assign(sessionData, values),
      },
    },
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener: (listener) => listeners.push(listener) },
      onInstalled: { addListener: () => {} },
    },
    tabs: {
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
      query: async () => [],
    },
    sidePanel: { setPanelBehavior: async () => {} },
  };

  await import(`../src/service-worker.js?seed-test=${Date.now()}`);
  const dispatch = (message) => new Promise((resolve) => listeners[0](message, {}, resolve));
  const seeded = await dispatch({ type: 'JOB_DATASOURCE_STATE' });
  assert.equal(seeded.ok, true);
  assert.equal(seeded.datasource.answerCount, 36);
  assert.equal(seeded.datasource.coverMessageCount, 1);
  assert.equal(localData.datasourceMeta.seedId, 'resume.xlsx');
  assert.equal(seedLoads, 1);

  localData.answerRecords = localData.answerRecords.map((record, index) => index === 0
    ? { ...record, answer: 'edited-local-answer', updatedAt: '2026-09-03T12:00:00.000Z' }
    : record);
  const reread = await dispatch({ type: 'JOB_DATASOURCE_STATE' });
  assert.equal(reread.datasource.answerCount, 36);
  assert.equal(localData.answerRecords[0].answer, 'edited-local-answer');
  assert.equal(seedLoads, 1);
});
