import test from 'node:test';
import assert from 'node:assert/strict';

function createHarness({
  autoAdvancePages = false,
  answerRecords = [{ key: 'full_name', question: 'Full name', answer: 'Nithin', aliases: ['Full name'], type: 'text', sensitivity: 'safe', updatedAt: '2025-01-01T00:00:00.000Z' }],
  coverMessages = [],
  pagesByTab = {},
} = {}) {
  const localData = {
    openaiApiKey: '',
    autoAdvancePages,
    answerRecords: [...answerRecords],
    coverMessages: [...coverMessages],
    datasourceMeta: null,
  };
  const sessionData = {};
  const listeners = [];
  const updatedListeners = [];
  const removedListeners = [];
  const tabs = new Map(Object.entries(pagesByTab).map(([tabId, spec]) => [Number(tabId), {
    currentPage: 0,
    nextClicks: 0,
    focusCalls: [],
    submitCalls: 0,
    messages: [],
    messageTargets: [],
    injections: [],
    frames: (spec.frames || [{ frameId: 0, context: null, pages: spec.pages }]).map((frame) => ({
      frameId: frame.frameId ?? 0,
      context: frame.context || {},
      currentPage: 0,
      failNextMessages: frame.failNextMessages || 0,
      pages: frame.pages.map((page) => ({ ...page })),
    })),
    pages: (spec.pages || []).map((page) => ({ ...page })),
  }]));

  function currentTabState(tabId) {
    const state = tabs.get(tabId);
    if (!state) throw new Error(`Unknown test tab ${tabId}`);
    return state;
  }

  function materializeField(field, valueOverrides = {}) {
    return {
      autocomplete: '',
      constraints: {},
      options: [],
      required: false,
      currentValue: '',
      ...field,
      currentValue: Object.prototype.hasOwnProperty.call(valueOverrides, field.id)
        ? valueOverrides[field.id]
        : (field.currentValue || ''),
    };
  }

  function frameFor(tabId, frameId = 0) {
    const state = currentTabState(tabId);
    const frame = state.frames.find((candidate) => candidate.frameId === frameId);
    if (!frame) throw new Error(`Unknown test frame ${frameId}`);
    if (state.frames.length === 1 && frameId === 0) frame.currentPage = state.currentPage;
    return frame;
  }

  function inspectionFor(tabId, frameId = 0) {
    const frame = frameFor(tabId, frameId);
    const page = frame.pages[frame.currentPage];
    return {
      page: page.page || { title: frame.context.title || `Step ${frame.currentPage + 1}`, domain: frame.context.domain || 'jobs.example.com' },
      fields: page.fields.map((field) => materializeField(field, page.values || {})),
      actions: page.actions || [],
      pauseReasons: page.pauseReasons || [],
    };
  }

  function validationFor(tabId, frameId = 0) {
    const frame = frameFor(tabId, frameId);
    const page = frame.pages[frame.currentPage];
    const inspection = inspectionFor(tabId, frameId);
    const requiredEmpty = inspection.fields
      .filter((field) => field.required && !String(field.currentValue || '').trim())
      .map((field) => ({ fieldId: field.id, label: field.label, type: field.type }));
    const invalid = new Set(page.invalidFieldIds || []);
    return {
      ok: requiredEmpty.length === 0 && invalid.size === 0,
      requiredEmpty,
      invalid: inspection.fields
        .filter((field) => invalid.has(field.id))
        .map((field) => ({ fieldId: field.id, label: field.label, type: field.type })),
    };
  }

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ output: [] }),
  });

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
        clear: async () => {
          for (const key of Object.keys(sessionData)) delete sessionData[key];
        },
      },
    },
    runtime: {
      onMessage: { addListener: (listener) => listeners.push(listener) },
      onInstalled: { addListener: () => {} },
      getURL: () => 'chrome-extension://seed-data.json',
    },
    tabs: {
      query: async () => [{ id: 7 }],
      sendMessage: async (tabId, message, options = {}) => {
        const state = currentTabState(tabId);
        const frameId = options.frameId ?? 0;
        const frame = frameFor(tabId, frameId);
        if (frame.failNextMessages > 0) {
          frame.failNextMessages -= 1;
          throw new Error(`Frame ${frameId} is not ready`);
        }
        state.messages.push(message);
        state.messageTargets.push({ message, frameId });
        const page = frame.pages[frame.currentPage];
        if (message.type === 'JOB_APP_INSPECT') return { ok: true, inspection: inspectionFor(tabId, frameId) };
        if (message.type === 'JOB_APP_APPLY') {
          for (const decision of message.decisions || []) {
            if (decision.action !== 'fill') continue;
            if (!page.values) page.values = {};
            if (!Object.prototype.hasOwnProperty.call(page.values, decision.fieldId)) page.values[decision.fieldId] = decision.value;
          }
          return { ok: true, result: { applied: [], kept: [], reviewRequired: [], unresolved: [], failed: [] } };
        }
        if (message.type === 'JOB_APP_VALIDATE') return { ok: true, validation: validationFor(tabId, frameId) };
        if (message.type === 'JOB_APP_CAPTURE') {
          const inspection = inspectionFor(tabId, frameId);
          return {
            ok: true,
            records: inspection.fields
              .filter((field) => String(field.currentValue || '').trim())
            .map((field) => ({
                key: field.id,
                question: field.label,
                answer: field.currentValue,
                formOrder: field.formOrder,
                aliases: [field.label],
                type: field.type,
                sensitivity: field.sensitivity || 'safe',
                provenance: field.provenance || 'user',
              })),
          };
        }
        if (message.type === 'JOB_APP_CLICK_NEXT') {
          state.nextClicks += 1;
          if (page.advanceOnClick) {
            frame.currentPage = Math.min(frame.currentPage + 1, frame.pages.length - 1);
            if (state.frames.length === 1 && frameId === 0) state.currentPage = frame.currentPage;
          }
          return { ok: true };
        }
        if (message.type === 'JOB_APP_FOCUS') {
          state.focusCalls.push(message.fieldId);
          return { ok: true };
        }
        if (message.type === 'JOB_APP_SUBMIT') {
          state.submitCalls += 1;
          return { ok: true };
        }
        return { ok: true };
      },
      onUpdated: { addListener: (listener) => updatedListeners.push(listener) },
      onRemoved: { addListener: (listener) => removedListeners.push(listener) },
    },
    scripting: {
      executeScript: async (details) => {
        const tabId = details.target?.tabId;
        if (!tabId || !tabs.has(tabId)) return [];
        const state = currentTabState(tabId);
        const frameIds = details.target?.allFrames
          ? state.frames.map((frame) => frame.frameId)
          : (details.target?.frameIds || [0]);
        if (details.func) {
          return frameIds.map((frameId) => {
            const frame = frameFor(tabId, frameId);
            return { frameId, result: { title: frame.context.title || '', pathname: frame.context.pathname || '' } };
          });
        }
        state.injections.push({ files: details.files || [], frameIds });
        return frameIds.map((frameId) => ({ frameId, result: undefined }));
      },
    },
    sidePanel: { setPanelBehavior: async () => {} },
  };

  return {
    localData,
    sessionData,
    listeners,
    tabs,
    updatedListeners,
    removedListeners,
    dispatch: async (message, sender = {}) => new Promise((resolve) => {
      const handled = listeners[0](message, sender, resolve);
      if (handled === false) resolve({ ok: false, unhandled: true });
    }),
  };
}

test('saved narrative and sensitive equivalents wait for scoped approval before any mutation', async () => {
  const harness = createHarness({ answerRecords: [
    { key: 'story', question: 'Model deployment project', answer: 'I trained machine learning models and deployed them to production.', confirmationState: 'confirmed', sensitivity: 'safe' },
    { key: 'current_salary', question: 'Current salary', answer: 'Synthetic explanation', confirmationState: 'confirmed', sensitivity: 'review' },
  ], pagesByTab: { 7: { pages: [{ page: { title: 'Application', domain: 'example.test' }, fields: [
    { id: 'ml', handle: 'handle-ml', label: 'Describe your ML experience', type: 'textarea', required: true },
    { id: 'ctc', handle: 'handle-ctc', label: 'Current CTC', type: 'textarea' },
  ], actions: [] }] } } });
  harness.localData.openaiApiKey = 'synthetic-test-key';
  let plannerCalls = 0;
  globalThis.fetch = async () => { plannerCalls++; throw new Error('synthetic planner unavailable'); };
  await import(`../src/service-worker.js?test=reuse-${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  assert.equal(plannerCalls, 0, 'AI must not bypass local approval gates');
  assert.equal(harness.tabs.get(7).frames[0].pages[0].values?.ctc, undefined);
  const { JSDOM } = await import('jsdom');
  const { applyDecisions } = await import('../src/form-engine.js');
  const document = new JSDOM('<label>Current CTC<textarea id="ctc"></textarea></label><label>Describe your ML experience<textarea id="ml"></textarea></label>').window.document;
  const sentDecisions = harness.tabs.get(7).messages.find(message => message.type === 'JOB_APP_APPLY').decisions;
  assert.equal(sentDecisions.find(decision => decision.fieldId === 'ctc').action, 'ask_user');
  assert.equal(sentDecisions.find(decision => decision.fieldId === 'ctc').value, null);
  await applyDecisions(document, sentDecisions.map(({ handle, ...decision }) => decision));
  assert.equal(document.querySelector('#ctc').value, '');
  assert.equal(document.querySelector('#ml').value, '');
  assert.equal(started.run.suggestions.ml.candidates[0].sourceKey, 'story');
  assert.equal(started.run.suggestions.ctc.candidates[0].sourceKey, 'current_salary');
  assert.match(started.run.actionRequired[0].reason, /evidence/i);
  const suggestion = started.run.suggestions.ctc;
  const approval = { type: 'JOB_RUN_APPROVE_SUGGESTION', tabId: 7, frameId: suggestion.frameId, applicationId: suggestion.applicationId, fieldId: 'ctc', handle: suggestion.field.handle, pageSignature: suggestion.pageSignature, sourceKey: 'current_salary' };
  for (const change of [{ tabId: 8 }, { frameId: 9 }, { applicationId: 'old' }, { handle: 'replaced' }]) assert.equal((await harness.dispatch({ ...approval, ...change })).ok, false);
  const accepted = await harness.dispatch(approval);
  assert.equal(accepted.ok, true, accepted.error);
  assert.equal(harness.tabs.get(7).frames[0].pages[0].values.ctc, 'Synthetic explanation');
  assert.equal(harness.tabs.get(7).nextClicks, 0);
  assert.equal(harness.tabs.get(7).submitCalls, 0);
  assert.equal((await harness.dispatch(approval)).ok, false);
  const learned = harness.localData.answerRecords.find(record => record.key === 'current_salary');
  assert.ok(learned.aliases.includes('Current CTC'));
  const narrative = started.run.suggestions.ml;
  const edited = await harness.dispatch({ ...approval, fieldId: 'ml', handle: narrative.field.handle, sourceKey: 'story', answer: 'I built and deployed synthetic ML models for this project.' });
  assert.equal(edited.ok, true, edited.error);
  const newRecord = harness.localData.answerRecords.find(record => record.question === 'Describe your ML experience');
  assert.deepEqual(newRecord.evidenceKeys, ['story']);
  assert.equal(harness.localData.answerRecords.find(record => record.key === 'story').aliases.includes('Describe your ML experience'), false);
});

test('previous application drafts are source-qualified suggestions, not promoted by scanning', async () => {
  const harness = createHarness({ pagesByTab: { 7: { pages: [{ page: { title: 'Application' }, fields: [{ id: 'notice', handle: 'notice-handle', label: 'Notice period', type: 'textarea', required: true }], actions: [{ id: 'submit', label: 'Submit application', kind: 'submit' }] }] } } });
  harness.localData.applicationDrafts = { old: { records: [{ key: 'notice', question: 'Notice period', answer: 'Synthetic notice answer', provenance: 'user', completed: true }] }, generated: { records: [{ key: 'notice', question: 'Notice period', answer: 'Generated answer', provenance: 'autofill' }] } };
  await import(`../src/service-worker.js?test=drafts-${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  const suggestion = started.run.suggestions.notice;
  assert.equal(suggestion.candidates.length, 1);
  assert.equal(suggestion.candidates[0].sourceKey, 'draft:old:notice');
  assert.match(suggestion.candidates[0].reason, /Previously entered, not yet saved for reuse/);
  assert.equal(harness.localData.answerRecords.some(record => record.key === 'notice'), false);
  const approved = await harness.dispatch({ type: 'JOB_RUN_APPROVE_SUGGESTION', tabId: 7, frameId: 0, applicationId: started.run.startedAt, pageSignature: started.run.pageSignature, fieldId: 'notice', handle: 'notice-handle', sourceKey: 'draft:old:notice' });
  assert.equal(approved.ok, true, approved.error);
  assert.equal(harness.localData.answerRecords.find(record => record.question === 'Notice period').answer, 'Synthetic notice answer');
});

test('optional planner sends bounded relevant evidence and preserves failure diagnostics without retries', async () => {
  const harness = createHarness({ pagesByTab: { 7: { pages: [{ fields: [{ id: 'unknown', label: 'Describe underwater welding', type: 'text', required: true }], actions: [{ id: 'submit', label: 'Submit application', kind: 'submit' }] }] } } });
  harness.localData.openaiApiKey = 'synthetic-key';
  const bodies = [];
  globalThis.fetch = async (_url, options) => { bodies.push(JSON.parse(options.body)); throw new Error('Synthetic network failure'); };
  await import(`../src/service-worker.js?test=bounded-${Date.now()}`);
  const first = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  assert.deepEqual(JSON.parse(bodies[0].input[1].content[0].text).records, []);
  assert.match(first.run.llmError, /Synthetic network failure/);
  await harness.dispatch({ type: 'JOB_RUN_CHECK_PAGE', tabId: 7 });
  assert.equal(bodies.length, 1);
});

test('planner fill candidates wait for explicit review instead of applying to the page', async () => {
  const plannerAnswer = 'I built and deployed machine learning models to production.';
  const harness = createHarness({ answerRecords: [{
    key: 'ml_delivery',
    question: 'Machine learning delivery project',
    answer: plannerAnswer,
    confirmationState: 'confirmed',
    sensitivity: 'safe',
  }], pagesByTab: { 7: { pages: [{ fields: [
    { id: 'ml_experience', handle: 'ml-experience-handle', label: 'Describe your ML deployment experience', type: 'textarea', required: true, currentValue: ' ' },
  ], actions: [{ id: 'submit', label: 'Submit application', kind: 'submit' }], invalidFieldIds: ['ml_experience'] }] } } });
  harness.localData.openaiApiKey = 'synthetic-planner-key';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ output_text: JSON.stringify({ decisions: [{
      fieldId: 'ml_experience', action: 'fill', value: plannerAnswer, evidenceKeys: ['ml_delivery'],
      confidence: 'high', sensitivity: 'safe', reason: 'Exact saved delivery evidence', transformation: 'copy',
    }] }) }),
  });
  await import(`../src/service-worker.js?planner-pending-${Date.now()}`);

  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });

  assert.equal(started.ok, true, started.error);
  assert.equal(harness.tabs.get(7).frames[0].pages[0].values?.ml_experience, undefined);
  const plannerFieldDecisions = harness.tabs.get(7).messages
    .filter((message) => message.type === 'JOB_APP_APPLY')
    .flatMap((message) => message.decisions || [])
    .filter((decision) => decision.fieldId === 'ml_experience');
  assert.equal(plannerFieldDecisions.some((decision) => decision.action === 'fill'), false);
  assert.ok(started.run.suggestions, JSON.stringify(started.run));
  const suggestion = started.run.suggestions.ml_experience;
  assert.ok(suggestion, JSON.stringify(started.run));
  assert.equal(started.run.actionRequired.find((item) => item.fieldId === 'ml_experience')?.suggestion, suggestion);
  assert.equal(suggestion.candidates.length, 1);
  assert.equal(suggestion.candidates[0].answer, plannerAnswer);
  assert.deepEqual(suggestion.candidates[0].sourceKeys, ['ml_delivery']);
  assert.deepEqual(suggestion.candidates[0].sourceAnswers, { ml_delivery: plannerAnswer });
  assert.equal(suggestion.candidates[0].provenance, 'AI planner');

  const checked = await harness.dispatch({ type: 'JOB_RUN_CHECK_PAGE', tabId: 7 });
  const retained = checked.run.suggestions?.ml_experience;
  assert.ok(retained, JSON.stringify(checked.run));
  assert.equal(retained.candidates[0].answer, plannerAnswer);
  assert.deepEqual(retained.candidates[0].sourceKeys, ['ml_delivery']);

  // The harness uses a whitespace-only invalid value to exercise the planner
  // path without allowing the deterministic path to claim the field. Restore
  // the visibly blank control before the user's explicit Send to form.
  const page = harness.tabs.get(7).frames[0].pages[0];
  page.fields[0].currentValue = '';
  page.invalidFieldIds = [];
  const approved = await harness.dispatch({
    type: 'JOB_RUN_APPROVE_SUGGESTION',
    tabId: 7,
    frameId: suggestion.frameId,
    applicationId: suggestion.applicationId,
    pageSignature: suggestion.pageSignature,
    fieldId: 'ml_experience',
    handle: suggestion.field.handle,
    sourceKey: suggestion.candidates[0].sourceKey,
    sourceKeys: suggestion.candidates[0].sourceKeys,
  });
  assert.equal(approved.ok, true, approved.error);
  assert.equal(page.values.ml_experience, plannerAnswer);
  assert.equal(approved.run.suggestions?.ml_experience, undefined);
});

test('planner candidates preserve every evidence snapshot and reject approval after any source changes', async () => {
  const plannerAnswer = 'I built and deployed machine learning systems in production.';
  const harness = createHarness({ answerRecords: [
    { key: 'ml_project', question: 'Machine learning delivery project', answer: plannerAnswer, confirmationState: 'confirmed', sensitivity: 'safe' },
    { key: 'ml_production', question: 'Machine learning production evidence', answer: plannerAnswer, confirmationState: 'confirmed', sensitivity: 'safe' },
  ], pagesByTab: { 7: { pages: [{ fields: [
    { id: 'ml_experience', handle: 'ml-experience-handle', label: 'Describe your ML deployment experience', type: 'textarea', required: true, currentValue: ' ' },
  ], actions: [{ id: 'submit', label: 'Submit application', kind: 'submit' }], invalidFieldIds: ['ml_experience'] }] } } });
  harness.localData.openaiApiKey = 'synthetic-planner-key';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ output_text: JSON.stringify({ decisions: [{
      fieldId: 'ml_experience', action: 'fill', value: plannerAnswer, evidenceKeys: ['ml_project', 'ml_production'],
      confidence: 'high', sensitivity: 'safe', reason: 'Saved delivery evidence', transformation: 'copy',
    }] }) }),
  });
  await import(`../src/service-worker.js?planner-sources-${Date.now()}`);

  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  assert.ok(started.run.suggestions, JSON.stringify(started.run));
  const suggestion = started.run.suggestions.ml_experience;
  assert.ok(suggestion, JSON.stringify(started.run));
  const candidate = suggestion.candidates[0];
  assert.deepEqual(candidate.sourceKeys, ['ml_project', 'ml_production']);
  assert.deepEqual(candidate.sourceAnswers, { ml_project: plannerAnswer, ml_production: plannerAnswer });
  assert.equal(candidate.transformation, 'copy');
  assert.equal(harness.tabs.get(7).frames[0].pages[0].values?.ml_experience, undefined);

  harness.localData.answerRecords = harness.localData.answerRecords.map((record) => record.key === 'ml_production'
    ? { ...record, answer: 'Changed machine learning evidence.' }
    : record);
  const rejected = await harness.dispatch({
    type: 'JOB_RUN_APPROVE_SUGGESTION',
    tabId: 7,
    frameId: suggestion.frameId,
    applicationId: suggestion.applicationId,
    pageSignature: suggestion.pageSignature,
    fieldId: 'ml_experience',
    handle: suggestion.field.handle,
    sourceKeys: candidate.sourceKeys,
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /evidence changed/i);
  assert.equal(harness.tabs.get(7).frames[0].pages[0].values?.ml_experience, undefined);

  harness.localData.answerRecords = harness.localData.answerRecords.map((record) => record.key === 'ml_production'
    ? { ...record, answer: plannerAnswer }
    : record);
  const page = harness.tabs.get(7).frames[0].pages[0];
  page.fields[0].currentValue = '';
  page.invalidFieldIds = [];
  const approved = await harness.dispatch({
    type: 'JOB_RUN_APPROVE_SUGGESTION',
    tabId: 7,
    frameId: suggestion.frameId,
    applicationId: suggestion.applicationId,
    pageSignature: suggestion.pageSignature,
    fieldId: 'ml_experience',
    handle: suggestion.field.handle,
    sourceKeys: candidate.sourceKeys,
  });
  assert.equal(approved.ok, true, approved.error);
  const approval = harness.tabs.get(7).messages
    .filter((message) => message.type === 'JOB_APP_APPLY')
    .flatMap((message) => message.decisions || [])
    .findLast((decision) => decision.fieldId === 'ml_experience' && decision.action === 'fill');
  assert.deepEqual(approval.evidenceKeys, ['ml_project', 'ml_production']);
  const learned = harness.localData.answerRecords.find((record) => record.question === 'Describe your ML deployment experience');
  assert.ok(learned);
  assert.deepEqual(learned.evidenceKeys, ['ml_project', 'ml_production']);
});

test('reviewed compensation preserves explicit answer units without numeric conversion', async () => {
  const harness = createHarness({ answerRecords: [{ key: 'current_salary', question: 'Current salary', answer: 'Reported compensation: 18 LPA.', confirmationState: 'confirmed', sensitivity: 'review' }], pagesByTab: { 7: { pages: [{ fields: [{ id: 'ctc', handle: 'ctc-h', label: 'Current CTC', type: 'textarea', required: true }], actions: [{ id: 'submit', label: 'Submit application', kind: 'submit' }] }] } } });
  await import(`../src/service-worker.js?test=units-${Date.now()}`);
  const { run } = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  assert.equal(run.suggestions.ctc.candidates[0].kind, 'review');
  const result = await harness.dispatch({ type: 'JOB_RUN_APPROVE_SUGGESTION', tabId: 7, frameId: 0, applicationId: run.startedAt, pageSignature: run.pageSignature, fieldId: 'ctc', handle: 'ctc-h', sourceKey: 'current_salary' });
  assert.equal(result.ok, true, result.error);
  assert.equal(harness.tabs.get(7).frames[0].pages[0].values.ctc, 'Reported compensation: 18 LPA.');
});

test('selects the application iframe and routes the run to that frame', async () => {
  const harness = createHarness({
    answerRecords: [
      { key: 'full_name', question: 'Full name', answer: 'Nithin', aliases: ['Full name'], type: 'text', sensitivity: 'safe' },
      { key: 'email', question: 'Email', answer: 'person@example.com', aliases: ['Email'], type: 'email', sensitivity: 'safe' },
    ],
    pagesByTab: {
      7: {
        frames: [
          {
            frameId: 0,
            context: { title: 'Working at Arm | Jobs & Careers', pathname: '/jobs/16536/principal-software-engineer/candidate' },
            pages: [{
              fields: [{ id: 'alert_email', label: 'Email *', type: 'text', required: true }],
              actions: [{ id: 'action_0', label: 'Subscribe', kind: 'other', type: 'button' }],
            }],
          },
          {
            frameId: 3,
            context: { title: 'Create Your Profile - Principal Software Engineer', pathname: '/jobs/16536/principal-software-engineer/candidate' },
            pages: [{
              fields: [
                { id: 'full_name', label: 'Full name', type: 'text', required: true },
                { id: 'email', label: 'Email', type: 'email', required: true },
              ],
              actions: [{ id: 'action_0', label: 'Next', kind: 'next', type: 'submit' }],
            }],
          },
        ],
      },
    },
  });

  await import(`../src/service-worker.js?test=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  const focused = await harness.dispatch({ type: 'JOB_RUN_FOCUS_FIELD', tabId: 7, fieldId: 'full_name' });
  const advanced = await harness.dispatch({ type: 'JOB_RUN_ADVANCE_PAGE', tabId: 7 });

  assert.equal(started.run.status, 'page_ready');
  assert.equal(started.run.frame.frameId, 3);
  assert.equal(focused.ok, true);
  assert.equal(advanced.ok, true);
  assert.equal(harness.tabs.get(7).messageTargets.some(({ message, frameId }) => message.type === 'JOB_APP_APPLY' && frameId === 3), true);
  assert.equal(harness.tabs.get(7).messageTargets
    .filter(({ message }) => ['JOB_APP_APPLY', 'JOB_APP_VALIDATE', 'JOB_APP_CAPTURE', 'JOB_APP_FOCUS', 'JOB_APP_CLICK_NEXT'].includes(message.type))
    .every(({ frameId }) => frameId === 3), true);
});

test('pauses without applying when no frame looks like an application', async () => {
  const harness = createHarness({
    pagesByTab: {
      7: {
        frames: [
          {
            frameId: 0,
            context: { title: 'Working at Arm | Jobs & Careers', pathname: '/jobs/16536/candidate' },
            pages: [{
              fields: [{ id: 'alert_email', label: 'Email for job alerts', type: 'text', required: true }],
              actions: [{ id: 'action_0', label: 'Subscribe', kind: 'other', type: 'button' }],
            }],
          },
          {
            frameId: 2,
            context: { title: 'Cookie Settings', pathname: '/cookie-preferences' },
            pages: [{
              fields: [{ id: 'cookie_consent', label: 'Cookie consent', type: 'checkbox', required: false }],
              actions: [{ id: 'action_0', label: 'Save preferences', kind: 'other', type: 'button' }],
            }],
          },
        ],
      },
    },
  });

  await import(`../src/service-worker.js?test=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });

  assert.equal(started.run.status, 'waiting_user');
  assert.equal(started.run.waitingFor, 'no_application_frame');
  assert.equal(harness.tabs.get(7).messages.some((message) => message.type === 'JOB_APP_APPLY'), false);
});

test('does not reject an application because a footer action mentions cookie settings', async () => {
  const harness = createHarness({
    pagesByTab: {
      7: {
        frames: [{
          frameId: 0,
          context: { title: 'updateValue', pathname: '/br/pt/apply' },
          pages: [{
            page: { title: 'updateValue', domain: 'careers.lilly.com' },
            fields: [{ id: 'full_name', label: 'Name given', type: 'text', required: true }],
            actions: [
              { id: 'action_0', label: 'Next', kind: 'next', type: 'submit' },
              { id: 'action_1', label: 'Careers website cookie settings', kind: 'other', type: 'a' },
            ],
          }],
        }],
      },
    },
  });

  await import(`../src/service-worker.js?lilly-footer=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });

  assert.equal(started.ok, true);
  assert.equal(started.run.status, 'page_ready');
  assert.equal(started.run.frame.frameId, 0);
});

test('pauses without applying when application frames tie', async () => {
  const harness = createHarness({
    answerRecords: [{ key: 'full_name', question: 'Full name', answer: 'Nithin', aliases: ['Full name'], type: 'text', sensitivity: 'safe' }],
    pagesByTab: {
      7: {
        frames: [
          {
            frameId: 1,
            context: { title: 'Candidate Application', pathname: '/apply' },
            pages: [{
              fields: [{ id: 'full_name', label: 'Full name', type: 'text', required: true }],
              actions: [{ id: 'action_0', label: 'Submit application', kind: 'submit', type: 'submit' }],
            }],
          },
          {
            frameId: 2,
            context: { title: 'Candidate Application', pathname: '/apply' },
            pages: [{
              fields: [{ id: 'full_name', label: 'Full name', type: 'text', required: true }],
              actions: [{ id: 'action_0', label: 'Submit application', kind: 'submit', type: 'submit' }],
            }],
          },
        ],
      },
    },
  });

  await import(`../src/service-worker.js?test=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });

  assert.equal(started.run.status, 'waiting_user');
  assert.equal(started.run.waitingFor, 'ambiguous_application_frame');
  assert.equal(harness.tabs.get(7).messages.some((message) => message.type === 'JOB_APP_APPLY'), false);
});

test('ignores navigation notifications from utility frames', async () => {
  const harness = createHarness({
    autoAdvancePages: true,
    answerRecords: [{ key: 'full_name', question: 'Full name', answer: 'Nithin', aliases: ['Full name'], type: 'text', sensitivity: 'safe' }],
    pagesByTab: {
      7: {
        frames: [
          {
            frameId: 0,
            context: { title: 'Job alerts', pathname: '/jobs/16536/candidate' },
            pages: [{
              fields: [{ id: 'alert_email', label: 'Email for job alerts', type: 'text', required: false }],
              actions: [{ id: 'action_0', label: 'Subscribe', kind: 'other', type: 'button' }],
            }],
          },
          {
            frameId: 3,
            context: { title: 'Candidate Application', pathname: '/apply' },
            pages: [
              {
                fields: [{ id: 'full_name', label: 'Full name', type: 'text', required: true }],
                actions: [{ id: 'action_0', label: 'Next', kind: 'next', type: 'submit' }],
                advanceOnClick: true,
              },
              {
                fields: [{ id: 'full_name', label: 'Full name', type: 'text', required: true }],
                actions: [{ id: 'action_0', label: 'Submit application', kind: 'submit', type: 'submit' }],
              },
            ],
          },
        ],
      },
    },
  });

  await import(`../src/service-worker.js?test=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  const inspectCountBefore = harness.tabs.get(7).messageTargets.filter(({ message }) => message.type === 'JOB_APP_INSPECT').length;
  const ignored = await harness.dispatch({ type: 'JOB_APP_NAVIGATED' }, { tab: { id: 7 }, frameId: 0 });

  assert.equal(started.run.status, 'running');
  assert.equal(ignored.run.status, 'running');
  assert.equal(ignored.run.pageNumber, 2);
  assert.equal(harness.tabs.get(7).messageTargets.filter(({ message }) => message.type === 'JOB_APP_INSPECT').length, inspectCountBefore);
});

test('processes navigation notifications from the selected application frame', async () => {
  const harness = createHarness({
    autoAdvancePages: true,
    answerRecords: [{ key: 'full_name', question: 'Full name', answer: 'Nithin', aliases: ['Full name'], type: 'text', sensitivity: 'safe' }],
    pagesByTab: {
      7: {
        frames: [
          {
            frameId: 0,
            context: { title: 'Job alerts', pathname: '/jobs/16536/candidate' },
            pages: [{
              fields: [{ id: 'alert_email', label: 'Email for job alerts', type: 'text', required: false }],
              actions: [{ id: 'action_0', label: 'Subscribe', kind: 'other', type: 'button' }],
            }],
          },
          {
            frameId: 3,
            context: { title: 'Candidate Application', pathname: '/apply' },
            pages: [
              {
                fields: [{ id: 'full_name', label: 'Full name', type: 'text', required: true }],
                actions: [{ id: 'action_0', label: 'Next', kind: 'next', type: 'submit' }],
                advanceOnClick: true,
              },
              {
                fields: [{ id: 'full_name', label: 'Full name', type: 'text', required: true }],
                actions: [{ id: 'action_0', label: 'Submit application', kind: 'submit', type: 'submit' }],
              },
            ],
          },
        ],
      },
    },
  });

  await import(`../src/service-worker.js?test=${Date.now()}`);
  await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  const navigated = await harness.dispatch({ type: 'JOB_APP_NAVIGATED' }, { tab: { id: 7 }, frameId: 3 });

  assert.equal(navigated.ok, true);
  assert.equal(navigated.run.status, 'ready_for_user_submit');
  assert.equal(navigated.run.pageNumber, 2);
  assert.equal(harness.tabs.get(7).messageTargets.filter(({ message }) => message.type === 'JOB_APP_APPLY').every(({ frameId }) => frameId === 3), true);
});

test('reinjects a stale frame before inspecting it', async () => {
  const harness = createHarness({
    answerRecords: [{ key: 'full_name', question: 'Full name', answer: 'Nithin', aliases: ['Full name'], type: 'text', sensitivity: 'safe' }],
    pagesByTab: {
      7: {
        frames: [{
          frameId: 3,
          failNextMessages: 1,
          context: { title: 'Candidate Application', pathname: '/apply' },
          pages: [{
            fields: [{ id: 'full_name', label: 'Full name', type: 'text', required: true }],
            actions: [{ id: 'action_0', label: 'Submit application', kind: 'submit', type: 'submit' }],
          }],
        }],
      },
    },
  });

  await import(`../src/service-worker.js?test=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });

  assert.equal(started.run.status, 'ready_for_user_submit');
  assert.equal(harness.tabs.get(7).injections.some(({ frameIds }) => frameIds.length === 1 && frameIds[0] === 3), true);
});

test('default run fills one page and stops in page_ready without clicking Next', async () => {
  const harness = createHarness({
    pagesByTab: {
      7: {
        pages: [{
          fields: [{ id: 'full_name', label: 'Full name', type: 'text', required: true }],
          actions: [{ id: 'action_0', label: 'Save and Continue', kind: 'next', type: 'submit' }],
        }],
      },
    },
  });

  await import(`../src/service-worker.js?test=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });

  assert.equal(started.ok, true);
  assert.equal(started.run.status, 'page_ready');
  assert.equal(harness.tabs.get(7).nextClicks, 0);
  assert.equal(started.run.nextAction?.id, 'action_0');
  assert.deepEqual(started.run.actionRequired, []);
  assert.equal(started.run.audit[0].answer, 'Nithin');
});

test('explicit page advance revalidates, captures, and clicks one Next action', async () => {
  const harness = createHarness({
    pagesByTab: {
      7: {
        pages: [
          {
            fields: [{ id: 'full_name', label: 'Full name', type: 'text', required: true }],
            actions: [{ id: 'action_0', label: 'Save and Continue', kind: 'next', type: 'submit' }],
          },
          {
            fields: [{ id: 'portfolio', label: 'Portfolio', type: 'url', required: false }],
            actions: [{ id: 'action_0', label: 'Submit application', kind: 'submit', type: 'submit' }],
          },
        ],
      },
    },
  });

  await import(`../src/service-worker.js?test=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  assert.equal(started.run.status, 'page_ready');

  const advancing = await harness.dispatch({ type: 'JOB_RUN_ADVANCE_PAGE', tabId: 7 });
  assert.equal(advancing.ok, true);
  assert.equal(advancing.run.status, 'running');
  assert.equal(harness.tabs.get(7).nextClicks, 1);

  harness.tabs.get(7).currentPage = 1;
  const navigated = await harness.dispatch({ type: 'JOB_APP_NAVIGATED' }, { tab: { id: 7 } });
  assert.equal(navigated.ok, true);
  assert.equal(navigated.run.status, 'ready_for_user_submit');
  assert.equal(navigated.run.pageNumber, 2);
});

test('autoAdvancePages true retains automatic page progression', async () => {
  const harness = createHarness({
    autoAdvancePages: true,
    pagesByTab: {
      7: {
        pages: [
          {
            fields: [{ id: 'full_name', label: 'Full name', type: 'text', required: true }],
            actions: [{ id: 'action_0', label: 'Next', kind: 'next', type: 'submit' }],
            advanceOnClick: true,
          },
          {
            fields: [{ id: 'cover_letter', label: 'Cover letter', type: 'textarea', required: false }],
            actions: [{ id: 'action_0', label: 'Submit application', kind: 'submit', type: 'submit' }],
          },
        ],
      },
    },
  });

  await import(`../src/service-worker.js?test=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  assert.equal(started.run.status, 'running');
  assert.equal(harness.tabs.get(7).nextClicks, 1);

  const navigated = await harness.dispatch({ type: 'JOB_APP_NAVIGATED' }, { tab: { id: 7 } });
  assert.equal(navigated.ok, true);
  assert.equal(navigated.run.status, 'ready_for_user_submit');
});

test('autoAdvancePages continues automatically after each navigation', async () => {
  const harness = createHarness({
    autoAdvancePages: true,
    pagesByTab: {
      7: {
        pages: [
          {
            fields: [{ id: 'full_name', label: 'Full name', type: 'text', required: true }],
            actions: [{ id: 'action_0', label: 'Next', kind: 'next', type: 'submit' }],
            advanceOnClick: true,
          },
          {
            fields: [{ id: 'full_name', label: 'Full name', type: 'text', required: true }],
            actions: [{ id: 'action_0', label: 'Next', kind: 'next', type: 'submit' }],
            advanceOnClick: true,
          },
          {
            fields: [{ id: 'full_name', label: 'Full name', type: 'text', required: true }],
            actions: [{ id: 'action_0', label: 'Submit application', kind: 'submit', type: 'submit' }],
          },
        ],
      },
    },
  });

  await import(`../src/service-worker.js?test=${Date.now()}`);
  await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  const firstNavigation = await harness.dispatch({ type: 'JOB_APP_NAVIGATED' }, { tab: { id: 7 } });
  assert.equal(firstNavigation.run.status, 'running');
  assert.equal(harness.tabs.get(7).nextClicks, 2);

  const finalNavigation = await harness.dispatch({ type: 'JOB_APP_NAVIGATED' }, { tab: { id: 7 } });
  assert.equal(finalNavigation.run.status, 'ready_for_user_submit');
  assert.equal(finalNavigation.run.pageNumber, 3);
});

test('does not advance beyond the 20-page limit', async () => {
  const pages = Array.from({ length: 20 }, (_, index) => ({
    fields: [{ id: 'full_name', label: 'Full name', type: 'text', required: true }],
    actions: [{ id: 'action_0', label: 'Next', kind: 'next', type: 'submit' }],
    advanceOnClick: index < 19,
  }));
  const harness = createHarness({ pagesByTab: { 7: { pages } } });

  await import(`../src/service-worker.js?test=${Date.now()}`);
  await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  let run = null;
  for (let page = 1; page < 20; page += 1) {
    const advanced = await harness.dispatch({ type: 'JOB_RUN_ADVANCE_PAGE', tabId: 7 });
    assert.equal(advanced.ok, true);
    run = await harness.dispatch({ type: 'JOB_APP_NAVIGATED' }, { tab: { id: 7 } });
    if (run.run.status === 'waiting_user') break;
  }

  assert.equal(run.run.status, 'waiting_user');
  assert.equal(run.run.pageNumber, 20);
  assert.equal(harness.tabs.get(7).nextClicks, 19);
});

test('worker categorizes blockers, optional unresolved fields, review items, and audit values separately', async () => {
  const harness = createHarness({
    answerRecords: [{ key: 'full_name', question: 'Full name', answer: 'Nithin', aliases: ['Full name'], type: 'text', sensitivity: 'safe' }],
    coverMessages: [{ id: 'default', title: 'Default', body: 'I would like to contribute to your team with a strong engineering background and hands-on execution across product delivery.' }],
    pagesByTab: {
      7: {
        pages: [{
          fields: [
            { id: 'full_name', label: 'Full name', type: 'text', required: true, formOrder: 0 },
            { id: 'work_authorization', label: 'Work authorization', type: 'text', required: true, formOrder: 1 },
            { id: 'portfolio', label: 'Portfolio', type: 'url', required: false, formOrder: 2 },
            { id: 'cover_letter', label: 'Cover letter', type: 'textarea', required: false, sensitivity: 'review', formOrder: 3 },
          ],
          actions: [{ id: 'action_0', label: 'Submit application', kind: 'submit', type: 'submit' }],
        }],
      },
    },
  });

  await import(`../src/service-worker.js?test=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });

  assert.equal(started.run.status, 'waiting_user');
  assert.equal(started.run.actionRequired.some((item) => item.fieldId === 'work_authorization'), true);
  assert.equal(started.run.optionalUnresolved.some((item) => item.fieldId === 'portfolio'), true);
  assert.equal(started.run.reviewRequired.some((item) => item.fieldId === 'cover_letter'), true);
  assert.equal(started.run.audit.some((item) => item.key === 'full_name'), true);
  assert.equal(started.run.actionRequired.find((item) => item.fieldId === 'work_authorization').formOrder, 1);
  assert.equal(started.run.optionalUnresolved.find((item) => item.fieldId === 'portfolio').formOrder, 2);
  assert.equal(started.run.reviewRequired.find((item) => item.fieldId === 'cover_letter').formOrder, 3);
  assert.equal(started.run.reviewRequired.find((item) => item.fieldId === 'cover_letter').pageNumber, 1);
  assert.equal(started.run.audit.find((item) => item.key === 'full_name').formOrder, 0);
  assert.equal(started.run.audit.find((item) => item.key === 'full_name').pageNumber, 1);
  assert.equal(harness.tabs.get(7).focusCalls[0], 'work_authorization');
});

test('final save persists answers without any submit message or site submit click', async () => {
  const harness = createHarness({
    pagesByTab: {
      7: {
        pages: [{
          fields: [
            { id: 'full_name', label: 'Full name', type: 'text', required: true },
            { id: 'github', label: 'GitHub', type: 'url', required: false, currentValue: 'https://github.com/nithin' },
          ],
          actions: [{ id: 'action_0', label: 'Submit application', kind: 'submit', type: 'submit' }],
        }],
      },
    },
  });

  await import(`../src/service-worker.js?test=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  assert.equal(started.run.status, 'ready_for_user_submit');
  assert.equal(harness.localData.answerRecords.some((record) => record.key === 'github'), false);

  const saved = await harness.dispatch({ type: 'JOB_RUN_SAVE_ANSWERS', tabId: 7 });
  assert.equal(saved.ok, true);
  assert.equal(saved.run.status, 'answers_saved');
  assert.equal(harness.localData.answerRecords.some((record) => record.key === 'github'), false);
  assert.equal(saved.persisted, 0);
  assert.equal(harness.tabs.get(7).submitCalls, 0);
  assert.equal(harness.tabs.get(7).messages.some((message) => message.type === 'JOB_APP_SUBMIT'), false);
});

test('saves manually filled values on an incomplete page without changing its step state', async () => {
  const harness = createHarness({
    pagesByTab: {
      7: {
        pages: [{
          fields: [
            { id: 'full_name', label: 'Full name', type: 'text', required: true },
            { id: 'work_authorization', label: 'Work authorization', type: 'text', required: true },
            { id: 'github', label: 'GitHub', type: 'url', required: false },
          ],
          actions: [{ id: 'action_0', label: 'Next', kind: 'next', type: 'submit' }],
        }],
      },
    },
  });

  await import(`../src/service-worker.js?per-page-save=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  assert.equal(started.run.status, 'waiting_user');

  const page = harness.tabs.get(7).frames[0].pages[0];
  page.values = { ...(page.values || {}), github: 'https://github.com/nithin' };
  const saved = await harness.dispatch({ type: 'JOB_RUN_SAVE_ANSWERS', tabId: 7 });

  assert.equal(saved.ok, true);
  assert.equal(saved.run.status, 'waiting_user');
  assert.equal(saved.savedCount, 0);
  assert.equal(saved.unresolved, 1);
  assert.equal(harness.localData.answerRecords.some((record) => record.key === 'github'), false);
  assert.equal(harness.tabs.get(7).submitCalls, 0);
  assert.equal(harness.tabs.get(7).messages.some((message) => message.type === 'JOB_APP_SUBMIT'), false);
});

test('keeps user-entered values as drafts until Save while excluding provisional autofill values', async () => {
  const harness = createHarness({
    pagesByTab: {
      7: {
        pages: [{
          fields: [
            { id: 'manual_answer', label: 'Preferred shift', type: 'text', currentValue: 'Evenings', provenance: 'user' },
            { id: 'provisional_answer', label: 'Autofilled detail', type: 'text', currentValue: 'Generated', provenance: 'autofill' },
          ],
          actions: [{ id: 'action_0', label: 'Submit application', kind: 'submit', type: 'submit' }],
        }],
      },
    },
  });

  await import(`../src/service-worker.js?test=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  assert.equal(started.run.status, 'ready_for_user_submit');
  assert.equal(harness.localData.answerRecords.some((record) => record.key === 'manual_answer'), false);
  assert.equal(harness.localData.answerRecords.some((record) => record.key === 'provisional_answer'), false);
  const saved = await harness.dispatch({ type: 'JOB_RUN_SAVE_ANSWERS', tabId: 7 });
  assert.equal(saved.persisted, 0);
  assert.equal(harness.localData.answerRecords.some((record) => record.key === 'manual_answer'), false);
});

test('field focus requests target the matching control and tab runs stay isolated', async () => {
  const harness = createHarness({
    answerRecords: [
      { key: 'full_name', question: 'Full name', answer: 'Nithin', aliases: ['Full name'], type: 'text', sensitivity: 'safe' },
      { key: 'email', question: 'Email', answer: 'person@example.com', aliases: ['Email'], type: 'text', sensitivity: 'safe' },
    ],
    pagesByTab: {
      7: {
        pages: [{
          fields: [
            { id: 'full_name', label: 'Full name', type: 'text', required: true },
            { id: 'portfolio', label: 'Portfolio', type: 'url', required: false },
          ],
          actions: [{ id: 'action_0', label: 'Submit application', kind: 'submit', type: 'submit' }],
        }],
      },
      8: {
        pages: [{
          fields: [{ id: 'email', label: 'Email', type: 'email', required: true }],
          actions: [{ id: 'action_0', label: 'Submit application', kind: 'submit', type: 'submit' }],
        }],
      },
    },
  });

  await import(`../src/service-worker.js?test=${Date.now()}`);
  const tabSeven = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  const tabEight = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 8 });
  const focused = await harness.dispatch({ type: 'JOB_RUN_FOCUS_FIELD', tabId: 7, fieldId: 'portfolio' });

  assert.equal(tabSeven.run.audit.some((item) => item.key === 'full_name'), true);
  assert.equal(tabEight.run.audit.some((item) => item.key === 'email'), true);
  assert.equal(tabSeven.run.audit.some((item) => item.key === 'email'), false);
  assert.equal(focused.ok, true);
  assert.deepEqual(harness.tabs.get(7).focusCalls, ['portfolio']);
  assert.deepEqual(harness.tabs.get(8).focusCalls, []);
});

test('old confirm-submit message path is removed', async () => {
  const harness = createHarness({
    pagesByTab: {
      7: {
        pages: [{
          fields: [{ id: 'full_name', label: 'Full name', type: 'text', required: true }],
          actions: [{ id: 'action_0', label: 'Submit application', kind: 'submit', type: 'submit' }],
        }],
      },
    },
  });

  await import(`../src/service-worker.js?test=${Date.now()}`);
  const response = await harness.dispatch({ type: 'JOB_RUN_CONFIRM_SUBMIT', tabId: 7 });
  assert.equal(response.unhandled, true);
});

test('serializes draft capture across tabs without promoting unsaved values', async () => {
  const page = { fields: [{ id: 'full_name', label: 'Full name', type: 'text', required: true }], actions: [{ id: 'action_0', label: 'Submit application', kind: 'submit', type: 'submit' }] };
  const harness = createHarness({ pagesByTab: { 7: { pages: [page] }, 8: { pages: [page] } } });
  await import(`../src/service-worker.js?concurrent=${Date.now()}`);
  const runs = await Promise.all([7, 8].map((tabId) => harness.dispatch({ type: 'JOB_RUN_START', tabId })));
  assert.deepEqual(Object.keys(harness.sessionData.applicationRun).sort(), ['7', '8']);
  const messages = runs.map(({ run }, index) => ({ type: 'JOB_APP_LEARN', applicationId: run.startedAt, records: [
    { key: `fact_${index}`, question: `Fact ${index}`, answer: `Value ${index}`, provenance: 'user', type: 'text' },
  ] }));
  const results = await Promise.all(messages.map((message, index) => harness.dispatch(message, { tab: { id: index + 7 }, frameId: 0 })));
  assert.ok(results.every((result) => result.ok));
  assert.equal(harness.localData.answerRecords.some((record) => record.key === 'fact_0'), false);
  assert.equal(harness.localData.answerRecords.some((record) => record.key === 'fact_1'), false);
  assert.equal(Object.keys(harness.localData.applicationDrafts).length, 2);
  const forbidden = await harness.dispatch(messages[0], { tab: { id: 7 }, frameId: 9 });
  assert.equal(forbidden.ok, false);
  await import(`../src/service-worker.js?restart=${Date.now()}`);
  const dispatchRestarted = (message, sender = {}) => new Promise((resolve) => harness.listeners.at(-1)(message, sender, resolve));
  const restored = await dispatchRestarted({ type: 'JOB_APP_LEARNING_STATUS' }, { tab: { id: 7 }, frameId: 0 });
  assert.equal(restored.applicationId, runs[0].run.startedAt);
  const correction = await dispatchRestarted({ type: 'JOB_DATASOURCE_CORRECT', key: 'fact_0', answer: 'Corrected' });
  assert.equal(correction.ok, false);
});

test('restored provisional values remain drafts until a user explicitly saves them', async () => {
  const harness = createHarness({ pagesByTab: { 7: { pages: [{
    fields: [{ id: 'detail', label: 'Detail', type: 'text', currentValue: 'Generated', provenance: 'autofill' }],
    actions: [{ id: 'action_0', label: 'Submit application', kind: 'submit', type: 'submit' }],
  }] } } });
  await import(`../src/service-worker.js?restore-provenance=${Date.now()}`);
  const { run } = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  const message = { type: 'JOB_APP_LEARN', applicationId: run.startedAt, records: [{ key: 'detail', question: 'Detail', answer: 'Generated', type: 'text', provenance: 'user' }] };
  await harness.dispatch(message, { tab: { id: 7 }, frameId: 0 });
  assert.equal(harness.localData.answerRecords.some((record) => record.key === 'detail'), false);
  message.records[0].answer = 'User correction';
  message.records[0].userEdited = true;
  await harness.dispatch(message, { tab: { id: 7 }, frameId: 0 });
  assert.equal(harness.localData.answerRecords.some((record) => record.key === 'detail'), false);
  harness.tabs.get(7).frames[0].pages[0].fields[0].currentValue = 'User correction';
  harness.tabs.get(7).frames[0].pages[0].fields[0].provenance = 'user';
  const saved = await harness.dispatch({ type: 'JOB_RUN_SAVE_ANSWERS', tabId: 7 });
  assert.equal(saved.persisted, 0);
  assert.equal(harness.localData.answerRecords.find((record) => record.key === 'detail'), undefined);
});

test('reactivates learning after native site navigation within the application', async () => {
  const harness = createHarness({ pagesByTab: { 7: { frames: [{ frameId: 0, context: { title: 'Job application', pathname: '/apply/step1' }, pages: [
    { fields: [{ id: 'full_name', label: 'Full name', type: 'text' }], actions: [{ id: 'action_0', label: 'Next', kind: 'next', type: 'button' }] },
    { fields: [{ id: 'city', label: 'City', type: 'text' }], actions: [{ id: 'action_0', label: 'Submit application', kind: 'submit', type: 'submit' }] },
  ] }] } } });
  await import(`../src/service-worker.js?native-next=${Date.now()}`);
  const { run } = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  harness.tabs.get(7).currentPage = 1;
  harness.tabs.get(7).frames[0].context.pathname = '/apply/step2';
  const restored = await harness.dispatch({ type: 'JOB_APP_LEARNING_STATUS' }, { tab: { id: 7 }, frameId: 0, url: 'https://jobs.example.com/apply/step2' });
  assert.equal(restored.applicationId, run.startedAt);
  assert.equal(harness.sessionData.applicationRun['7'].frame.pathname, '/apply/step2');
  const offsite = await harness.dispatch({ type: 'JOB_APP_LEARNING_STATUS' }, { tab: { id: 7 }, frameId: 0, url: 'https://unrelated.example/apply/step2' });
  assert.equal(offsite.ok, false);
});

test('automatic generated drafts use job context and records, and regenerate only for the current field', async () => {
  const harness = createHarness({ answerRecords: [{ key: 'experience', question: 'Experience', answer: 'Built reliable event processing services.', confirmationState: 'confirmed', sensitivity: 'safe' }], pagesByTab: { 7: { frames: [{ frameId: 0, context: { title: 'Application' }, pages: [{
    page: { title: 'Apply — Platform Engineer', domain: 'jobs.example.com', role: 'Platform Engineer', jobDescription: 'Build distributed systems.' },
    fields: [{ id: 'why', handle: 'why-h', label: 'Why are you a good fit for this role?', type: 'textarea', required: true, labelConfidence: 'high' }], actions: [{ id: 'next', label: 'Next', kind: 'next' }],
  }] }] } } });
  harness.localData.openaiApiKey = 'synthetic-test-key';
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    const request = JSON.parse(bodies.at(-1).input[1].content[0].text);
    if (request.fields) return { ok: true, status: 200, statusText: 'OK', json: async () => ({ output_text: JSON.stringify({ decisions: [{ fieldId: 'why', action: 'ask_user', value: null, evidenceKeys: [], confidence: 'low', sensitivity: 'safe', reason: 'Needs a tailored draft', transformation: null }] }) }) };
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ output_text: JSON.stringify({ suggestions: [{ answer: 'I built reliable event processing services that match this platform role.', evidenceKeys: ['experience'] }], missingContext: '' }) }) };
  };
  await import(`../src/service-worker.js?generated-${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  assert.equal(started.ok, true, started.error);
  assert.equal(started.run.status, 'waiting_user', JSON.stringify(started.run));
  const generated = started.run.generatedSuggestions.why;
  assert.equal(started.run.suggestions?.why, undefined, 'an adjacent experience record is context, not a verbatim saved answer');
  assert.equal(bodies.length, 2, JSON.stringify(started.run));
  assert.ok(generated, started.run.llmError);
  assert.equal(generated.suggestions.length, 1);
  assert.match(JSON.stringify(bodies[1]), /Build distributed systems/);
  assert.match(JSON.stringify(bodies[1]), /event processing/);
  assert.deepEqual(harness.tabs.get(7).frames[0].pages[0].values || {}, {});
  const checked = await harness.dispatch({ type: 'JOB_RUN_CHECK_PAGE', tabId: 7 });
  assert.equal(bodies.length, 2, 'the same page reuses cached generated drafts');
  assert.equal(checked.run.generatedSuggestions.why.suggestions.length, 1);
  const refreshed = await harness.dispatch({ type: 'JOB_RUN_GENERATE_SUGGESTIONS', tabId: 7, frameId: 0, applicationId: started.run.startedAt, pageSignature: started.run.pageSignature, fieldId: 'why', handle: 'why-h', jobDescription: 'Operate a large-scale distributed platform.' });
  assert.equal(refreshed.ok, true, refreshed.error);
  assert.equal(refreshed.run.jobContext.jobDescription, 'Operate a large-scale distributed platform.');
  assert.equal(refreshed.run.generatedSuggestions.why.suggestions.length, 1);
});

function draftOrigin(run, field) {
  return {
    tabId: 7,
    frameId: run.frame.frameId,
    applicationId: run.startedAt,
    pageSignature: run.pageSignature,
    fieldId: field.id,
    handle: field.handle,
  };
}

test('manual drafts fill only the exact user value and do not promote an answer record', async () => {
  const harness = createHarness({ pagesByTab: { 7: { pages: [{
    page: { title: 'Application', domain: 'example.test' },
    fields: [{ id: 'summary', handle: 'summary-h', label: 'Professional summary', type: 'textarea', required: true }],
    actions: [{ id: 'submit', label: 'Submit application', kind: 'submit', type: 'submit' }],
  }] } } });
  await import(`../src/service-worker.js?manual-draft=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  const recordsBefore = structuredClone(harness.localData.answerRecords);
  const draftsBefore = structuredClone(harness.localData.applicationDrafts || {});
  const answer = '  I build reliable data products.  ';
  const result = await harness.dispatch({ type: 'JOB_RUN_APPLY_DRAFT', ...draftOrigin(started.run, { id: 'summary', handle: 'summary-h' }), answer });
  assert.equal(result.ok, true, result.error);
  assert.equal(harness.tabs.get(7).frames[0].pages[0].values.summary, answer);
  assert.deepEqual(harness.localData.answerRecords, recordsBefore);
  assert.deepEqual(harness.localData.applicationDrafts || {}, draftsBefore);
  const fills = harness.tabs.get(7).messages
    .filter((message) => message.type === 'JOB_APP_APPLY')
    .flatMap((message) => message.decisions || [])
    .filter((decision) => decision.action === 'fill' && decision.fieldId === 'summary');
  assert.equal(fills.length, 1);
  assert.equal(fills[0].value, answer);
});

test('manual drafts reject stale origins and changed destinations before filling', async () => {
  const harness = createHarness({ pagesByTab: { 7: { pages: [{
    page: { title: 'Application', domain: 'example.test' },
    fields: [{ id: 'summary', handle: 'summary-h', label: 'Professional summary', type: 'text', required: true }], actions: [{ id: 'submit', label: 'Submit application', kind: 'submit', type: 'submit' }],
  }] } } });
  await import(`../src/service-worker.js?manual-stale=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  const origin = draftOrigin(started.run, { id: 'summary', handle: 'summary-h' });
  for (const stale of [
    { tabId: 8 }, { frameId: 4 }, { applicationId: 'stale-run' }, { pageSignature: 'stale-page' }, { handle: 'other-handle' },
  ]) {
    const result = await harness.dispatch({ type: 'JOB_RUN_APPLY_DRAFT', ...origin, ...stale, answer: 'A safe answer' });
    assert.equal(result.ok, false);
  }
  assert.equal(harness.tabs.get(7).frames[0].pages[0].values?.summary, undefined);
  harness.tabs.get(7).frames[0].pages[0].fields[0].label = 'Changed question';
  const changed = await harness.dispatch({ type: 'JOB_RUN_APPLY_DRAFT', ...origin, answer: 'A safe answer' });
  assert.equal(changed.ok, false);
  assert.equal(harness.tabs.get(7).frames[0].pages[0].values?.summary, undefined);
});

test('manual drafts replace only an invalid existing field value', async () => {
  const harness = createHarness({ pagesByTab: { 7: { pages: [{
    page: { title: 'Application', domain: 'example.test' },
    fields: [
      { id: 'invalid_summary', handle: 'invalid-h', label: 'Professional summary', type: 'text', required: true, currentValue: 'invalid value' },
      { id: 'valid_summary', handle: 'valid-h', label: 'Professional summary', type: 'text', required: true, currentValue: 'Retain this answer' },
    ],
    invalidFieldIds: ['invalid_summary'],
    actions: [{ id: 'submit', label: 'Submit application', kind: 'submit', type: 'submit' }],
  }] } } });
  await import(`../src/service-worker.js?replace-invalid=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  const repaired = await harness.dispatch({
    type: 'JOB_RUN_APPLY_DRAFT',
    ...draftOrigin(started.run, { id: 'invalid_summary', handle: 'invalid-h' }),
    answer: 'Corrected answer',
  });
  assert.equal(repaired.ok, true, repaired.error);
  assert.equal(harness.tabs.get(7).frames[0].pages[0].values.invalid_summary, 'Corrected answer');
  const blocked = await harness.dispatch({
    type: 'JOB_RUN_APPLY_DRAFT',
    ...draftOrigin(started.run, { id: 'valid_summary', handle: 'valid-h' }),
    answer: 'Do not replace this',
  });
  assert.equal(blocked.ok, false);
  assert.equal(harness.tabs.get(7).frames[0].pages[0].values?.valid_summary, undefined);
});

test('manual drafts reject invalid, legal, checkbox, and opaque values without mutation', async () => {
  const harness = createHarness({ pagesByTab: { 7: { pages: [{
    page: { title: 'Application', domain: 'example.test' },
    fields: [
      { id: 'choice', handle: 'choice-h', label: 'Preferred location', type: 'select', required: true, options: ['Bangalore', 'Remote'] },
      { id: 'short', handle: 'short-h', label: 'Brief answer', type: 'text', required: true, constraints: { minLength: 8 } },
      { id: 'consent', handle: 'consent-h', label: 'Privacy agreement', type: 'text', required: true },
      { id: 'privacy_acknowledgement', handle: 'generic-legal-h', label: 'Response', type: 'text', required: true },
      { id: 'agree', handle: 'agree-h', label: 'I agree', type: 'checkbox', required: true },
      { id: 'opaque', handle: 'opaque-h', label: 'Reference code', type: 'text', required: true },
    ], actions: [],
  }] } } });
  await import(`../src/service-worker.js?manual-invalid=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  const attempts = [
    [{ id: 'choice', handle: 'choice-h' }, 'Everywhere'],
    [{ id: 'short', handle: 'short-h' }, 'short'],
    [{ id: 'consent', handle: 'consent-h' }, 'yes'],
    [{ id: 'privacy_acknowledgement', handle: 'generic-legal-h' }, 'yes'],
    [{ id: 'agree', handle: 'agree-h' }, 'yes'],
    [{ id: 'opaque', handle: 'opaque-h' }, 'cards|d20089ff-f389-44ef-9398-eec15ba7b6a4[field1]'],
  ];
  for (const [field, answer] of attempts) {
    const result = await harness.dispatch({ type: 'JOB_RUN_APPLY_DRAFT', ...draftOrigin(started.run, field), answer });
    assert.equal(result.ok, false, `${field.id} should be rejected`);
  }
  assert.deepEqual(harness.tabs.get(7).frames[0].pages[0].values || {}, {});
});

test('draft apply and rewrite requests are accepted only from the extension panel', async () => {
  const harness = createHarness({ pagesByTab: { 7: { pages: [{
    page: { title: 'Application', domain: 'example.test' },
    fields: [{ id: 'summary', handle: 'summary-h', label: 'Professional summary', type: 'text', required: true }],
    actions: [{ id: 'submit', label: 'Submit application', kind: 'submit', type: 'submit' }],
  }] } } });
  harness.localData.openaiApiKey = 'synthetic-test-key';
  await import(`../src/service-worker.js?panel-only=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  const origin = draftOrigin(started.run, { id: 'summary', handle: 'summary-h' });
  const sender = { tab: { id: 7 }, frameId: 0 };
  const apply = await harness.dispatch({ type: 'JOB_RUN_APPLY_DRAFT', ...origin, answer: 'A safe answer' }, sender);
  const rewrite = await harness.dispatch({ type: 'JOB_RUN_REWRITE_ANSWER', ...origin, draft: 'A safe answer', instruction: 'Be concise.' }, sender);
  assert.equal(apply.ok, false);
  assert.equal(rewrite.ok, false);
  assert.deepEqual(harness.tabs.get(7).frames[0].pages[0].values || {}, {});
});

test('generic-label legal IDs stay gated and cannot be approved as saved answers', async () => {
  const harness = createHarness({
    answerRecords: [{ key: 'privacy_acknowledgement', question: 'Response', answer: 'yes', aliases: ['Response'], type: 'text', sensitivity: 'safe', confirmationState: 'confirmed' }],
    pagesByTab: { 7: { pages: [{
      page: { title: 'Application', domain: 'example.test' },
      fields: [{ id: 'privacy_acknowledgement', handle: 'privacy-h', label: 'Response', type: 'text', required: true }],
      actions: [{ id: 'submit', label: 'Submit application', kind: 'submit', type: 'submit' }],
    }] } },
  });
  await import(`../src/service-worker.js?generic-legal-id=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  const suggestion = started.run.suggestions?.privacy_acknowledgement;
  assert.ok(suggestion, 'legal field IDs must require an explicit manual decision');
  assert.equal(harness.tabs.get(7).frames[0].pages[0].values?.privacy_acknowledgement, undefined);
  const approval = await harness.dispatch({
    type: 'JOB_RUN_APPROVE_SUGGESTION',
    ...draftOrigin(started.run, { id: 'privacy_acknowledgement', handle: 'privacy-h' }),
    sourceKey: 'privacy_acknowledgement',
  });
  assert.equal(approval.ok, false);
  assert.equal(harness.tabs.get(7).frames[0].pages[0].values?.privacy_acknowledgement, undefined);
});

test('rewrite uses the selected model and relevant current evidence without mutating the page or datasource', async () => {
  const harness = createHarness({
    answerRecords: [{ key: 'story', question: 'Project history', answer: 'I delivered a reliable platform.', type: 'textarea', sensitivity: 'safe', confirmationState: 'confirmed' }],
    pagesByTab: { 7: { pages: [{
      page: { title: 'Application', domain: 'example.test' },
      fields: [{ id: 'summary', handle: 'summary-h', label: 'Project history', type: 'textarea', required: true }], actions: [{ id: 'submit', label: 'Submit application', kind: 'submit', type: 'submit' }],
    }] } },
  });
  harness.localData.openaiApiKey = 'synthetic-test-key';
  harness.localData.openaiModel = 'rewrite-model';
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ answer: 'I delivered a dependable platform.' }) }] }] }) };
  };
  await import(`../src/service-worker.js?rewrite-ok=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  const origin = draftOrigin(started.run, { id: 'summary', handle: 'summary-h' });
  const recordsBefore = structuredClone(harness.localData.answerRecords);
  const valuesBefore = structuredClone(harness.tabs.get(7).frames[0].pages[0].values || {});
  const result = await harness.dispatch({ type: 'JOB_RUN_REWRITE_ANSWER', ...origin, question: 'Project history', draft: 'I delivered a reliable platform.', instruction: 'Make this more concise.', sourceKey: 'story' });
  assert.deepEqual(result, { ok: true, answer: 'I delivered a dependable platform.' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, 'rewrite-model');
  const prompt = JSON.parse(requests[0].input[1].content[0].text);
  assert.equal(prompt.question, 'Project history');
  assert.equal(prompt.records[0].key, 'story');
  assert.deepEqual(harness.tabs.get(7).frames[0].pages[0].values || {}, valuesBefore);
  assert.deepEqual(harness.localData.answerRecords, recordsBefore);
  assert.equal(JSON.stringify(result).includes('synthetic-test-key'), false);
});

test('rewrite rejects unsafe requests and model failures without mutating a draft destination', async () => {
  const harness = createHarness({
    answerRecords: [{ key: 'story', question: 'Project history', answer: 'I delivered a reliable platform.', type: 'textarea', sensitivity: 'safe', confirmationState: 'confirmed' }],
    pagesByTab: { 7: { pages: [{ page: { title: 'Application', domain: 'example.test' }, fields: [{ id: 'summary', handle: 'summary-h', label: 'Project history', type: 'textarea', required: true }], actions: [{ id: 'submit', label: 'Submit application', kind: 'submit', type: 'submit' }] }] } },
  });
  harness.localData.openaiApiKey = 'synthetic-test-key';
  await import(`../src/service-worker.js?rewrite-errors=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  const origin = draftOrigin(started.run, { id: 'summary', handle: 'summary-h' });
  const base = { type: 'JOB_RUN_REWRITE_ANSWER', ...origin, question: 'Project history', draft: 'I delivered a reliable platform.', instruction: 'Make this concise.', sourceKey: 'story' };
  const valuesBefore = structuredClone(harness.tabs.get(7).frames[0].pages[0].values || {});
  const recordsBefore = structuredClone(harness.localData.answerRecords);
  for (const invalid of [
    { applicationId: 'stale-run' }, { draft: '' }, { instruction: '' }, { draft: 42 }, { instruction: 'x'.repeat(4_001) },
  ]) {
    const result = await harness.dispatch({ ...base, ...invalid });
    assert.equal(result.ok, false);
  }
  harness.localData.openaiApiKey = '';
  const missingKey = await harness.dispatch(base);
  assert.equal(missingKey.ok, false);
  harness.localData.openaiApiKey = 'synthetic-test-key';
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ output_text: '{not valid JSON' }) });
  const malformed = await harness.dispatch(base);
  assert.equal(malformed.ok, false);
  globalThis.fetch = async () => { throw new Error('Synthetic network failure'); };
  const network = await harness.dispatch(base);
  assert.equal(network.ok, false);
  assert.deepEqual(harness.tabs.get(7).frames[0].pages[0].values || {}, valuesBefore);
  assert.deepEqual(harness.localData.answerRecords, recordsBefore);
});
