import test from 'node:test';
import assert from 'node:assert/strict';

test('runs deterministic plus LLM fill, gates submission, and saves confirmed answers once', async () => {
  const localData = {
    openaiApiKey: 'test-key',
    answerRecords: [{ key: 'candidate_name', question: 'Candidate profile fact', answer: 'Nithin', aliases: [], type: 'text', sensitivity: 'safe', updatedAt: '2025-01-01T00:00:00.000Z' }],
  };
  const sessionData = {};
  const listeners = [];
  const updatedListeners = [];
  const removedListeners = [];
  let currentValue = '';
  let plannerCalls = 0;
  let submissions = 0;

  const field = {
    id: 'full_name',
    label: 'Full name',
    type: 'text',
    autocomplete: 'name',
    required: true,
    options: [],
    constraints: {},
    get currentValue() { return currentValue; },
  };
  const inspection = () => ({
    page: { title: 'Demo application', domain: 'jobs.example.com' },
    fields: [{ ...field, currentValue }],
    actions: [{ id: 'action_0', label: 'Submit application', kind: 'submit', type: 'submit' }],
    pauseReasons: [],
  });

  globalThis.fetch = async () => {
    plannerCalls += 1;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ decisions: [{
        fieldId: 'full_name', action: 'fill', value: 'Nithin', evidenceKeys: ['candidate_name'], confidence: 'high', sensitivity: 'safe', reason: 'Learned profile value',
      }] }) }] }] }),
    };
  };

  globalThis.chrome = {
    storage: {
      local: {
        get: async (defaults) => ({ ...defaults, ...localData }),
        set: async (values) => Object.assign(localData, values),
        remove: async (keys) => keys.forEach((key) => delete localData[key]),
        setAccessLevel: async () => {},
      },
      session: {
        get: async (defaults) => ({ ...defaults, ...sessionData }),
        set: async (values) => Object.assign(sessionData, values),
      },
    },
    runtime: {
      onMessage: { addListener: (listener) => listeners.push(listener) },
      onInstalled: { addListener: () => {} },
    },
    tabs: {
      query: async () => [{ id: 7 }],
      sendMessage: async (_tabId, message) => {
        if (message.type === 'JOB_APP_INSPECT') return { ok: true, inspection: inspection() };
        if (message.type === 'JOB_APP_APPLY') {
          const decision = message.decisions.find((item) => item.action === 'fill');
          if (decision) currentValue = decision.value;
          return { ok: true, result: { applied: [], kept: [], reviewRequired: [], unresolved: [], failed: [] } };
        }
        if (message.type === 'JOB_APP_VALIDATE') return { ok: true, validation: { ok: Boolean(currentValue), requiredEmpty: currentValue ? [] : [{ fieldId: 'full_name', label: 'Full name' }], invalid: [] } };
        if (message.type === 'JOB_APP_CAPTURE') return { ok: true, records: currentValue ? [{ key: 'full_name', question: 'Full name', answer: currentValue, aliases: ['Full name'], type: 'text', sensitivity: 'safe' }] : [] };
        if (message.type === 'JOB_APP_SUBMIT') { submissions += 1; return { ok: true }; }
        return { ok: true };
      },
      onUpdated: { addListener: (listener) => updatedListeners.push(listener) },
      onRemoved: { addListener: (listener) => removedListeners.push(listener) },
    },
    scripting: { executeScript: async () => {} },
    sidePanel: { setPanelBehavior: async () => {} },
  };

  await import(`../src/service-worker.js?test=${Date.now()}`);
  const dispatch = (message) => new Promise((resolve) => listeners[0](message, {}, resolve));

  const started = await dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  assert.equal(started.ok, true);
  assert.equal(started.run.status, 'ready_to_submit');
  assert.equal(plannerCalls, 1);
  assert.equal(localData.answerRecords.length, 1);

  const confirmed = await dispatch({ type: 'JOB_RUN_CONFIRM_SUBMIT', tabId: 7 });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.run.status, 'submitted');
  assert.equal(submissions, 1);
  assert.equal(localData.answerRecords.find((record) => record.key === 'full_name').answer, 'Nithin');

  const duplicate = await dispatch({ type: 'JOB_RUN_CONFIRM_SUBMIT', tabId: 7 });
  assert.equal(duplicate.ok, false);
  assert.equal(submissions, 1);
  const secondRun = await dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  assert.equal(secondRun.run.status, 'ready_to_submit');
  assert.equal(plannerCalls, 1);
  assert.equal(updatedListeners.length, 1);
  assert.equal(removedListeners.length, 1);
});
