import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';
import { JSDOM } from 'jsdom';

function createHarness({
  autoAdvancePages = false,
  waitForAI = true,
  disabledHostnames = [],
  answerRecords = [{ key: 'full_name', question: 'Full name', answer: 'Nithin', aliases: ['Full name'], type: 'text', sensitivity: 'safe', updatedAt: '2025-01-01T00:00:00.000Z' }],
  coverMessages = [],
  pagesByTab = {},
} = {}) {
  const localData = {
    openaiApiKey: '',
    autoAdvancePages,
    disabledHostnames: [...disabledHostnames],
    // Fixture profile represents explicitly reviewed facts unless overridden.
    answerRecords: answerRecords.map(record => ({confirmationState:'confirmed',...record})),
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
    url: spec.url || spec.pages?.[0]?.url || `https://${spec.pages?.[0]?.page?.domain || 'jobs.example.com'}/apply`,
  }]));

  function currentTabState(tabId) {
    const state = tabs.get(tabId);
    if (!state) throw new Error(`Unknown test tab ${tabId}`);
    return state;
  }

  function materializeField(field, valueOverrides = {}) {
    return {
      labelConfidence: 'high',
      autocomplete: '',
      constraints: {},
      options: [],
      required: false,
      currentValue: '',
      ...field,
      ...(Object.hasOwn(field, 'rawValue') ? {rawValue: Object.hasOwn(valueOverrides, field.id) ? valueOverrides[field.id] : field.rawValue} : {}),
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
      page: {...(page.page || { title: frame.context.title || `Step ${frame.currentPage + 1}`, domain: frame.context.domain || 'jobs.example.com' })},
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
      id: 'test-extension',
      onMessage: { addListener: (listener) => listeners.push(listener) },
      onInstalled: { addListener: () => {} },
      getURL: (path = '') => `chrome-extension://test-extension/${path}`,
    },
    tabs: {
      query: async () => [{ id: 7, url: tabs.get(7)?.url }],
      get: async (tabId) => ({ id: tabId, url: tabs.get(tabId)?.url }),
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
        if (message.type === 'JOB_APP_INSPECT_INLINE') {
          await page.onInlineInspect?.({ page, tabId, frameId });
          const inspection = inspectionFor(tabId, frameId);
          inspection.page.url = page.url || frame.context.url || 'https://jobs.example.com/apply';
          const focused = inspection.fields.find(field => field.id === (page.focusedFieldId === undefined ? inspection.fields[0]?.id : page.focusedFieldId));
          return { ok: true, inspection, focusedFieldId: focused?.id ?? null, focusedHandle: focused?.handle ?? null,
            rawValue: focused ? (page.values?.[focused.id] ?? focused.rawValue) : null, editRevision: focused?.editRevision ?? null };
        }
        if (message.type === 'JOB_APP_APPLY') {
          await page.beforeApply?.({ page, message, tabId, frameId });
          const failed = [];
          for (const decision of message.decisions || []) {
            if (decision.action !== 'fill') continue;
            const field = page.fields.find(field => field.id === decision.fieldId);
            if ((Object.hasOwn(decision, 'expectedRawValue') && (page.values?.[field.id] ?? field.rawValue) !== decision.expectedRawValue)
              || (Object.hasOwn(decision, 'expectedEditRevision') && field.editRevision !== decision.expectedEditRevision)) {
              failed.push({ fieldId: decision.fieldId, reason: 'Destination changed' });
              continue;
            }
            if (!page.values) page.values = {};
            if (!Object.prototype.hasOwnProperty.call(page.values, decision.fieldId)) page.values[decision.fieldId] = decision.value;
          }
          page.onApply?.({ page, decisions: message.decisions || [] });
          return { ok: true, result: { applied: [], kept: [], reviewRequired: [], unresolved: [], failed } };
        }
        if (message.type === 'JOB_APP_VALIDATE') {
          const validation = await page.onValidate?.({ page, tabId, frameId });
          return { ok: true, validation: validation || validationFor(tabId, frameId) };
        }
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
    dispatch: async (message, sender = { id: 'test-extension', url: 'chrome-extension://test-extension/sidepanel.html' }) => {
      const response=await new Promise(resolve=>{const handled=listeners[0](message,sender,resolve);if(handled===false)resolve({ok:false,unhandled:true});});
      if(waitForAI && response.run && !['JOB_RUN_STATE','JOB_RUN_VALIDATE_PAGE'].includes(message.type)) {
        const until=Date.now()+2000;
        while(Object.values(sessionData.applicationRun?.[String(message.tabId || 7)]?.aiOperations || {}).some(op=>op.status==='pending') && Date.now()<until) await new Promise(resolve=>setTimeout(resolve,5));
        response.run=sessionData.applicationRun?.[String(message.tabId || 7)] || response.run;
      }
      return response;
    },
  };
}

test('site controls normalize, persist, and match only the active exact hostname', async () => {
  const harness = createHarness({
    disabledHostnames: ['Jobs.Example.com', 'jobs.example.com'],
    pagesByTab: {7: {url: 'https://jobs.example.com/apply?step=1', pages: [{
      page: {title: 'Job application', domain: 'jobs.example.com'}, fields: [], actions: [],
    }] }},
  });
  await import(`../src/service-worker.js?site-control-state=${Date.now()}`);
  const state = await harness.dispatch({type: 'JOB_SITE_CONTROL_STATE'});
  assert.equal(state.ok, true, state.error);
  assert.deepEqual(state.site.disabledHostnames, ['jobs.example.com']);
  assert.equal(state.site.hostname, 'jobs.example.com');
  assert.equal(state.site.disabled, true);
  const blocked = await harness.dispatch({type: 'JOB_RUN_START', tabId: 7});
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /disabled on this site/i);
  const enabled = await harness.dispatch({type: 'JOB_SITE_SET_DISABLED', tabId: 7, disabled: false});
  assert.equal(enabled.ok, true, enabled.error);
  assert.equal(enabled.site.disabled, false);
  assert.deepEqual(harness.localData.disabledHostnames, []);
});

test('disabled site rejects inline requests and prevents a late run write after revocation', async () => {
  const harness = createHarness({
    disabledHostnames: [],
    pagesByTab: {7: {url: 'https://jobs.example.com/apply', pages: [{
      page: {title: 'Job application', domain: 'jobs.example.com'},
      fields: [{id: 'name', handle: 'name-h', label: 'Full name', type: 'text'}], actions: [{id: 'submit', label: 'Submit application', kind: 'submit', type: 'submit'}],
      beforeApply: async () => {
        await harness.dispatch({type: 'JOB_SITE_SET_DISABLED', tabId: 7, disabled: true});
      },
    }] }},
  });
  await import(`../src/service-worker.js?site-control-block=${Date.now()}`);
  const run = await harness.dispatch({type: 'JOB_RUN_START', tabId: 7});
  assert.equal(run.ok, true, run.error);
  assert.equal(run.run, null);
  assert.equal(harness.tabs.get(7).pages[0].values?.name, undefined);
  const inline = await harness.dispatch({type: 'JOB_INLINE_QUERY', requestId: 'r', fieldId: 'name', handle: 'name-h'}, {
    id: 'test-extension', tab: {id: 7, url: 'https://jobs.example.com/apply'}, frameId: 0, url: 'https://jobs.example.com/apply', origin: 'https://jobs.example.com',
  });
  assert.equal(inline.ok, false);
  assert.match(inline.error, /disabled on this site/i);
});

test('inline lookup works with no run and never fills on focus', async () => {
  const harness = createHarness({pagesByTab: {7: {pages: [{
    page: {title: 'Job application', domain: 'jobs.example.com'},
    fields: [{id: 'name', handle: 'doc-a:name', label: 'Full name',
      type: 'text', rawValue: '', editRevision: 0}], actions: [],
  }]}}});
  await import(`../src/service-worker.js?test=inline-query-${Date.now()}`);
  const sender = {id: chrome.runtime.id, tab: {id: 7}, frameId: 0,
    documentId: 'doc-a', url: 'https://jobs.example.com/apply'};
  const response = await harness.dispatch({type: 'JOB_INLINE_QUERY',
    fieldId: 'name', handle: 'doc-a:name', requestId: 'query-1'}, sender);
  assert.equal(response.ok, true, response.error);
  assert.equal(response.candidates[0].answer, 'Nithin');
  assert.equal(harness.sessionData.applicationRun?.['7'], undefined);
  assert.equal(harness.tabs.get(7).messages.some(m => m.type === 'JOB_APP_APPLY'), false);
  assert.equal(harness.tabs.get(7).nextClicks, 0);
  assert.equal(harness.tabs.get(7).submitCalls, 0);
});

const inlineSender = (overrides = {}) => ({ id: 'test-extension', tab: {id: 7}, frameId: 0, documentId: 'doc-a', url: 'https://jobs.example.com/apply', ...overrides });
const inlineQuery = (overrides = {}) => ({ type: 'JOB_INLINE_QUERY', fieldId: 'name', handle: 'doc-a:name', requestId: 'query-1', ...overrides });
const inlineGeneration = (query, requestId = 'generate-1') => ({type: 'JOB_INLINE_GENERATE', sessionId: query.sessionId, requestId});
const generatedResponse = (suggestions = [{answer: 'Nithin', evidenceKeys: ['full_name']}], missingContext = '') => ({ok: true, status: 200, statusText: 'OK', json: async () => ({output_text: JSON.stringify({suggestions, missingContext})})});
async function waitUntil(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'Expected deferred provider operation to start');
}
const inlineAcceptance = (query, overrides = {}) => ({ type: 'JOB_INLINE_ACCEPT', sessionId: query.sessionId, requestId: 'accept-1', candidateId: query.candidates[0].candidateId, acceptanceToken: 'content-token', ...overrides });
async function inlineHarness({ field = {}, page = {}, ...options } = {}) {
  const harness = createHarness({pagesByTab: {7: {pages: [{page: {title: 'Job application', domain: 'jobs.example.com'}, fields: [
    {id: 'name', handle: 'doc-a:name', label: 'Full name', type: 'text', rawValue: '', editRevision: 0, ...field},
  ], actions: [], ...page}]}}, ...options});
  await import(`../src/service-worker.js?test=inline-${Date.now()}-${Math.random()}`);
  return harness;
}

const panelOrigin = session => ({tabId: session.tabId, frameId: session.frameId, inlineSessionId: session.sessionId, fieldId: session.field.id, handle: session.field.handle, pageSignature: session.pageSignature, applicationId: session.attachedRun?.applicationId || session.sessionId});
async function handoffInline(harness, query, sender = inlineSender()) {
  return harness.dispatch({type: 'JOB_INLINE_EDIT_IN_PANEL', sessionId: query.sessionId, candidateId: query.candidates[0]?.candidateId}, sender);
}

for (const support of ['available', 'missing', 'rejected']) test(`inline panel handoff opens before async storage with ${support} API and no run`, async () => {
  const harness = await inlineHarness();
  const query = await harness.dispatch(inlineQuery(), inlineSender());
  const calls = [];
  if (support !== 'missing') chrome.sidePanel.open = ({tabId}) => {calls.push(`open:${tabId}`); return support === 'rejected' ? Promise.reject(new Error('Gesture expired')) : Promise.resolve();};
  const get = chrome.storage.session.get;
  chrome.storage.session.get = async defaults => {calls.push('storage'); return get(defaults);};
  const response = await handoffInline(harness, query);
  assert.equal(response.ok, true, response.error);
  if (support !== 'missing') assert.equal(calls[0], 'open:7');
  if (support !== 'available') assert.equal(response.error, 'Open the extension toolbar button to continue editing');
  const state = await harness.dispatch({type: 'JOB_INLINE_PANEL_STATE', tabId: 7});
  assert.equal(state.inlineSession.sessionId, query.sessionId);
  assert.equal(state.inlineSession.panelCandidateId, query.candidates[0].candidateId);
  assert.equal(harness.sessionData.applicationRun?.['7'], undefined);
  assert.equal((await harness.dispatch({type: 'JOB_INLINE_PANEL_STATE', tabId: 8})).inlineSession, null);
  assert.equal((await harness.dispatch({type: 'JOB_INLINE_PANEL_STATE', tabId: 7}, inlineSender())).ok, false);
  const closed = await harness.dispatch({type: 'JOB_INLINE_PANEL_STATE', ...panelOrigin(state.inlineSession), close: true});
  assert.equal(closed.inlineSession, null);
  assert.equal((await harness.dispatch({type: 'JOB_INLINE_PANEL_STATE', tabId: 7})).inlineSession, null);
});

test('inline panel child-frame focus and edited saved approval use the live session and existing shared write', async () => {
  const field = {id: 'name', handle: 'doc-a:name', label: 'Full name', type: 'text', rawValue: '', editRevision: 0};
  const harness = await inlineHarness({pagesByTab: {7: {frames: [{frameId: 3, pages: [{fields: [field]}]}]}}});
  const sender = inlineSender({frameId: 3});
  const query = await harness.dispatch(inlineQuery(), sender);
  await handoffInline(harness, query, sender);
  const {inlineSession} = await harness.dispatch({type: 'JOB_INLINE_PANEL_STATE', tabId: 7});
  assert.ok(inlineSession);
  const origin = panelOrigin(inlineSession);
  harness.tabs.get(7).frames[0].pages[0].focusedFieldId = null;
  const focus = await harness.dispatch({type: 'JOB_RUN_FOCUS_FIELD', ...origin});
  assert.equal(focus.ok, true, focus.error);
  assert.equal(harness.tabs.get(7).messageTargets.find(({message}) => message.type === 'JOB_APP_FOCUS').frameId, 3);
  const applied = await harness.dispatch({type: 'JOB_RUN_APPROVE_SUGGESTION', ...origin, sourceKey: 'full_name', answer: 'Nithin edited'});
  assert.equal(applied.ok, true, applied.error); assert.ok(applied.inlineSession);
  assert.equal(harness.tabs.get(7).frames[0].pages[0].values.name, 'Nithin edited');
  assert.equal(harness.sessionData.applicationRun?.['7'], undefined);
});

test('inline panel rejects changed destinations and untrusted origins before applying', async () => {
  const harness = await inlineHarness();
  const query = await harness.dispatch(inlineQuery(), inlineSender()); await handoffInline(harness, query);
  const {inlineSession} = await harness.dispatch({type: 'JOB_INLINE_PANEL_STATE', tabId: 7});
  assert.ok(inlineSession);
  const message = {type: 'JOB_RUN_APPLY_DRAFT', ...panelOrigin(inlineSession), answer: 'Manual draft'};
  assert.equal((await harness.dispatch(message, inlineSender())).ok, false);
  harness.tabs.get(7).frames[0].pages[0].fields[0].editRevision++;
  assert.equal((await harness.dispatch(message)).ok, false);
  assert.equal(harness.tabs.get(7).messages.some(message => message.type === 'JOB_APP_APPLY'), false);
});

test('inline panel search, rewrite and generation share existing operations without a listed run field', async () => {
  const harness = await inlineHarness(); harness.localData.openaiApiKey = 'synthetic-key';
  const query = await harness.dispatch(inlineQuery(), inlineSender()); await handoffInline(harness, query);
  const {inlineSession} = await harness.dispatch({type: 'JOB_INLINE_PANEL_STATE', tabId: 7}); assert.ok(inlineSession);
  const origin = panelOrigin(inlineSession);
  harness.tabs.get(7).frames[0].pages[0].focusedFieldId = null;
  const searched = await harness.dispatch({type: 'JOB_RUN_SEARCH_ANSWERS', ...origin, query: 'Nithin'});
  assert.equal(searched.ok, true, searched.error); assert.equal(searched.candidates[0].sourceKey, 'full_name');
  globalThis.fetch = async () => ({ok: true, json: async () => ({output_text: JSON.stringify({answer: 'Nithin', evidenceKeys: ['full_name']})})});
  const rewritten = await harness.dispatch({type: 'JOB_RUN_REWRITE_ANSWER', ...origin, draft: 'Nithin', instruction: 'Keep concise', sourceKey: 'full_name'});
  assert.equal(rewritten.ok, true, rewritten.error); assert.equal(rewritten.answer, 'Nithin'); assert.ok(rewritten.inlineSession);
  globalThis.fetch = async () => generatedResponse();
  const generated = await harness.dispatch({type: 'JOB_RUN_GENERATE_SUGGESTIONS', ...origin});
  assert.equal(generated.ok, true, generated.error); assert.equal(generated.inlineSession.generatedSuggestions.name.suggestions[0].answer, 'Nithin');
  const before = structuredClone(harness.localData.answerRecords);
  const applied = await harness.dispatch({type: 'JOB_RUN_APPLY_DRAFT', ...origin, answer: 'Manual draft'});
  assert.equal(applied.ok, true, applied.error); assert.deepEqual(harness.localData.answerRecords, before);
});

test('inline panel apply refreshes its attached real run after releasing the save lock', async () => {
  const harness = await inlineHarness({field: {label: 'Current CTC', type: 'textarea'},
    answerRecords: [{key: 'current_salary', question: 'Current salary', answer: 'Synthetic explanation', sensitivity: 'review'}],
    page: {actions: [{id: 'submit', label: 'Submit application', kind: 'submit'}]}});
  await harness.dispatch({type: 'JOB_RUN_START', tabId: 7});
  const query = await harness.dispatch(inlineQuery(), inlineSender()); await handoffInline(harness, query);
  const {inlineSession} = await harness.dispatch({type: 'JOB_INLINE_PANEL_STATE', tabId: 7});
  assert.ok(inlineSession.attachedRun);
  const applied = await harness.dispatch({type: 'JOB_RUN_APPLY_DRAFT', ...panelOrigin(inlineSession), answer: 'Reviewed salary explanation'});
  assert.equal(applied.ok, true, applied.error);
  assert.equal(applied.run.suggestions.name, undefined);
  assert.equal(applied.run.status, 'ready_for_user_submit');
});

test('closing the latest handoff cannot resurrect an earlier requested frame', async () => {
  const field = {id: 'name', handle: 'doc-a:name', label: 'Full name', type: 'text', rawValue: '', editRevision: 0};
  const harness = await inlineHarness({pagesByTab: {7: {frames: [0, 3].map(frameId => ({frameId, pages: [{fields: [field]}]}))}}});
  for (const frameId of [0, 3]) {
    const sender = inlineSender({frameId});
    const query = await harness.dispatch(inlineQuery(), sender); await handoffInline(harness, query, sender);
  }
  const {inlineSession} = await harness.dispatch({type: 'JOB_INLINE_PANEL_STATE', tabId: 7});
  assert.equal(inlineSession.frameId, 3);
  await harness.dispatch({type: 'JOB_INLINE_PANEL_STATE', ...panelOrigin(inlineSession), close: true});
  assert.equal((await harness.dispatch({type: 'JOB_INLINE_PANEL_STATE', tabId: 7})).inlineSession, null);
});

async function inlinePanelIntegration(t) {
  const harness = await inlineHarness();
  const content = new JSDOM('<form><label>Full name<input id="name"></label></form><button id="outside">Outside</button>', {url: 'https://jobs.example.com/apply', pretendToBeVisual: true});
  const panel = new JSDOM(await readFile(new URL('../sidepanel.html', import.meta.url), 'utf8'), {url: 'https://extension.local/sidepanel.html', pretendToBeVisual: true});
  t.after(() => {content.window.close(); panel.window.close();});
  const contentListeners = [], storageListeners = [], contentMessages = [];
  const set = chrome.storage.session.set;
  chrome.storage.session.set = async values => {
    const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {newValue: structuredClone(value)}]));
    await set(values);
    storageListeners.forEach(listener => listener(changes, 'session'));
  };
  const contentContext = createContext({document: content.window.document, setTimeout, clearTimeout, console, chrome: {...chrome, runtime: {
    sendMessage: message => {contentMessages.push(message); return harness.dispatch(message, inlineSender());},
    onMessage: {addListener: listener => contentListeners.push(listener)},
  }}});
  new Script(await readFile(new URL('../dist/content.js', import.meta.url), 'utf8')).runInContext(contentContext);
  chrome.tabs.sendMessage = (_tabId, message) => new Promise(resolve => contentListeners[0](message, {}, resolve));
  const panelContext = createContext({window: panel.window, document: panel.window.document, navigator: panel.window.navigator,
    structuredClone, setTimeout, clearTimeout, console, chrome: {...chrome,
      runtime: {sendMessage: message => harness.dispatch(message)},
      storage: {...chrome.storage, onChanged: {addListener: listener => storageListeners.push(listener)}},
    }});
  new Script(await readFile(new URL('../src/sidepanel.js', import.meta.url), 'utf8')).runInContext(panelContext);
  const field = content.window.document.querySelector('#name');
  field.focus();
  await waitUntil(() => harness.sessionData.inlineFieldSessions?.['7:0']?.field);
  await new Promise(resolve => setTimeout(resolve, 0));
  const popup = content.window.document.querySelector('[data-job-inline-autofill]').shadowRoot;
  popup.querySelector('[role="option"]').click();
  [...popup.querySelectorAll('button')].find(button => button.textContent === 'Edit in panel').click();
  await waitUntil(() => !panel.window.document.querySelector('#inline-field-card').hidden);
  const card = panel.window.document.querySelector('#inline-field-card');
  const draft = card.querySelector('[data-answer-draft]');
  draft.value = 'Edited in the panel'; draft.dispatchEvent(new panel.window.Event('input'));
  content.window.document.querySelector('#outside').focus();
  return {harness, content, panel, card, field, contentMessages};
}

test('panel Show on page preserves the handed-off session and edited draft while ordinary focus still queries', async t => {
  const {harness, content, card, field, contentMessages} = await inlinePanelIntegration(t);
  const sessionId = harness.sessionData.inlineFieldSessions['7:0'].sessionId;
  const queries = contentMessages.filter(message => message.type === 'JOB_INLINE_QUERY').length;
  card.querySelector('[data-field-id]').click();
  await waitUntil(() => content.window.document.activeElement === field);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(contentMessages.filter(message => message.type === 'JOB_INLINE_QUERY').length, queries);
  assert.equal(harness.sessionData.inlineFieldSessions['7:0'].sessionId, sessionId);
  assert.equal(harness.sessionData.inlineFieldSessions['7:0'].panelRequested, true);
  assert.equal(card.hidden, false);
  assert.equal(card.querySelector('[data-answer-draft]').value, 'Edited in the panel');
  content.window.document.querySelector('#outside').focus(); field.focus();
  await waitUntil(() => contentMessages.filter(message => message.type === 'JOB_INLINE_QUERY').length === queries + 1);
  await waitUntil(() => harness.sessionData.inlineFieldSessions['7:0'].sessionId !== sessionId && harness.sessionData.inlineFieldSessions['7:0'].field);
});

test('panel Show on page rejects a same-ID replacement between worker inspection and content focus', async t => {
  const {harness, content, panel, card, field, contentMessages} = await inlinePanelIntegration(t);
  const queries = contentMessages.filter(message => message.type === 'JOB_INLINE_QUERY').length;
  const send = chrome.tabs.sendMessage;
  let replacement, focusResponse;
  chrome.tabs.sendMessage = (tabId, message, options) => {
    if (message.type === 'JOB_APP_FOCUS') {
      replacement = field.cloneNode(); field.replaceWith(replacement);
    }
    const response = send(tabId, message, options);
    if (message.type === 'JOB_APP_FOCUS') response.then(result => {focusResponse = result;});
    return response;
  };
  card.querySelector('[data-field-id]').click();
  await waitUntil(() => focusResponse);
  assert.equal(focusResponse.ok, false);
  assert.match(panel.window.document.querySelector('#status').textContent, /Could not show/);
  assert.ok(replacement);
  assert.equal(content.window.document.activeElement.id, 'outside');
  assert.equal(replacement.classList.contains('job-autofill-focus-highlight'), false);
  assert.equal(content.window.document.querySelector('.job-autofill-focus-highlight'), null);
  assert.equal(contentMessages.filter(message => message.type === 'JOB_INLINE_QUERY').length, queries);
  assert.equal(harness.sessionData.inlineFieldSessions['7:0'].panelRequested, true);
  assert.equal(card.querySelector('[data-answer-draft]').value, 'Edited in the panel');
});

test('inline explicit generation without a run creates selectable drafts without learning or applying', async () => {
  const harness = await inlineHarness({waitForAI: false});
  harness.localData.openaiApiKey = 'synthetic-test-key';
  let calls = 0;
  globalThis.fetch = async () => {calls++; return generatedResponse();};
  const query = await harness.dispatch(inlineQuery(), inlineSender());
  assert.equal(calls, 0, 'focus lookup cannot call AI');
  const before = structuredClone(harness.localData.answerRecords);
  const response = await harness.dispatch(inlineGeneration(query), inlineSender());
  assert.equal(response.ok, true, response.error);
  assert.equal(calls, 1);
  assert.equal(response.generatedSuggestion.suggestions[0].answer, 'Nithin');
  assert.ok(response.generatedSuggestion.snapshot.evidenceRevision);
  assert.match(response.candidates[0].candidateId, /^saved:/);
  const draft = response.candidates.find(candidate => candidate.kind === 'generated');
  assert.match(draft.candidateId, /^generated:/);
  assert.equal(draft.requiresApproval, false);
  assert.deepEqual(draft.evidenceKeys, ['full_name']);
  assert.equal(harness.tabs.get(7).messages.some(message => message.type === 'JOB_APP_APPLY'), false);
  const accepted = await harness.dispatch(inlineAcceptance(response, {candidateId: draft.candidateId, answer: 'Forged'}), inlineSender());
  assert.equal(accepted.ok, true, accepted.error);
  assert.equal(harness.tabs.get(7).frames[0].pages[0].values.name, 'Nithin');
  assert.deepEqual(harness.localData.answerRecords, before, 'generated provenance is not reusable evidence authority');
  assert.equal(harness.sessionData.applicationRun?.['7'], undefined);
});

test('inline generation without a key or with provider failure preserves saved choices', async () => {
  const harness = await inlineHarness();
  const query = await harness.dispatch(inlineQuery(), inlineSender());
  const missing = await harness.dispatch(inlineGeneration(query), inlineSender());
  assert.equal(missing.ok, false);
  assert.match(missing.error, /API key/);
  harness.localData.openaiApiKey = 'synthetic-test-key';
  globalThis.fetch = async () => {throw new Error('Synthetic provider failure');};
  const failed = await harness.dispatch(inlineGeneration(query, 'generate-2'), inlineSender());
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Synthetic provider failure/);
  assert.deepEqual(harness.sessionData.inlineFieldSessions['7:0'].suggestions.name.candidates, query.candidates);
  assert.equal((await harness.dispatch(inlineAcceptance(query), inlineSender())).ok, true);
});

test('deferred inline generation rejects changed field, profile, job context, settings and deleted evidence', async () => {
  for (const change of ['raw', 'editRevision', 'profile', 'jobContext', 'provider', 'model', 'deletedEvidence', 'newSession', 'navigation']) {
    const harness = await inlineHarness({waitForAI: false});
    harness.localData.openaiApiKey = 'synthetic-test-key';
    let release, called = false;
    globalThis.fetch = () => {called = true; return new Promise(resolve => {release = resolve;});};
    const query = await harness.dispatch(inlineQuery(), inlineSender());
    const pending = harness.dispatch(inlineGeneration(query), inlineSender());
    await waitUntil(() => called);
    const page = harness.tabs.get(7).frames[0].pages[0];
    if (change === 'raw') page.fields[0].rawValue = ' ';
    if (change === 'editRevision') page.fields[0].editRevision++;
    if (change === 'profile') harness.localData.profile = {employment: [{id: 'new', company: 'Changed'}]};
    if (change === 'jobContext') page.page.jobDescription = 'Different requirements';
    if (change === 'provider') harness.localData.aiProvider = 'fireworks';
    if (change === 'model') harness.localData.aiModel = 'different-model';
    if (change === 'deletedEvidence') harness.localData.answerRecords = [];
    let newer;
    if (change === 'newSession') newer = await harness.dispatch(inlineQuery({requestId: 'query-2'}), inlineSender());
    if (change === 'navigation') await harness.dispatch({type: 'JOB_APP_NAVIGATED'}, inlineSender());
    const before = structuredClone(harness.localData.answerRecords);
    release(generatedResponse());
    const response = await pending;
    assert.equal(response.ok, false, change);
    assert.equal(harness.sessionData.inlineFieldSessions['7:0']?.generatedSuggestions?.name, undefined, change);
    if (newer) assert.equal(harness.sessionData.inlineFieldSessions['7:0'].sessionId, newer.sessionId);
    assert.equal(harness.tabs.get(7).messages.some(message => message.type === 'JOB_APP_APPLY'), false, change);
    assert.deepEqual(harness.localData.answerRecords, before, change);
  }
});

test('only one inline request can be pending and generated acceptance rechecks evidence', async () => {
  const harness = await inlineHarness({waitForAI: false});
  harness.localData.openaiApiKey = 'synthetic-test-key';
  let release, calls = 0;
  globalThis.fetch = () => {calls++; return new Promise(resolve => {release = resolve;});};
  const query = await harness.dispatch(inlineQuery(), inlineSender());
  const pending = harness.dispatch(inlineGeneration(query), inlineSender());
  await waitUntil(() => calls === 1);
  const duplicate = await harness.dispatch(inlineGeneration(query, 'generate-2'), inlineSender());
  assert.equal(duplicate.ok, true, duplicate.error);
  assert.equal(duplicate.error, 'This answer is already being prepared');
  assert.equal(calls, 1);
  release(generatedResponse());
  const response = await pending;
  assert.equal(response.ok, true, response.error);
  harness.localData.answerRecords = [];
  const draft = response.candidates.find(candidate => candidate.kind === 'generated');
  assert.equal((await harness.dispatch(inlineAcceptance(response, {candidateId: draft.candidateId}), inlineSender())).ok, false);
  assert.equal(harness.tabs.get(7).messages.some(message => message.type === 'JOB_APP_APPLY'), false);
});

test('generated acceptance rejects evidence or settings changed during the final destination guard', async () => {
  for (const change of ['evidence', 'model']) {
    const harness = await inlineHarness();
    harness.localData.openaiApiKey = 'synthetic-test-key';
    globalThis.fetch = async () => generatedResponse();
    const query = await harness.dispatch(inlineQuery(), inlineSender());
    const generated = await harness.dispatch(inlineGeneration(query), inlineSender());
    const draft = generated.candidates.find(candidate => candidate.kind === 'generated');
    let inspections = 0;
    harness.tabs.get(7).frames[0].pages[0].onInlineInspect = () => {
      if (++inspections !== 3) return;
      if (change === 'evidence') harness.localData.answerRecords = [];
      else harness.localData.aiModel = 'different-model';
    };
    const accepted = await harness.dispatch(inlineAcceptance(generated, {candidateId: draft.candidateId}), inlineSender());
    assert.equal(accepted.ok, false, change);
    assert.equal(harness.tabs.get(7).messages.some(message => message.type === 'JOB_APP_APPLY'), false, change);
  }
});

test('inline generated requests reject legal, unresolved-employment and unsupported controls before AI', async () => {
  for (const field of [{label: 'I agree to terms and conditions'}, {type: 'select'}, {label: 'Job title', entityType: 'employment', entityId: 'work-1'}]) {
    const harness = await inlineHarness({field});
    harness.localData.profile = {employment: [{id: 'a', company: 'A'}, {id: 'b', company: 'B'}]};
    harness.localData.openaiApiKey = 'synthetic-test-key';
    let calls = 0;
    globalThis.fetch = async () => {calls++; return generatedResponse();};
    const query = await harness.dispatch(inlineQuery(), inlineSender());
    const generated = await harness.dispatch(inlineGeneration({...query, sessionId: query.sessionId || 'invalid'}), inlineSender());
    assert.equal(generated.ok, false);
    assert.equal(calls, 0);
  }
});

test('inline generation reuses completed panel snapshots and deduplicates same-field background work', async () => {
  const drafts = [{answer: 'Built reliable event processing services.', evidenceKeys: ['experience']}];
  for (const route of ['panel', 'background']) {
    const harness = await inlineHarness({waitForAI: false, answerRecords: [{key: 'experience', question: 'Experience', answer: 'Built reliable event processing services.', confirmationState: 'confirmed', sensitivity: 'safe'}], field: {id: 'why', handle: 'doc-a:why', label: 'Why are you a good fit?', type: 'textarea', required: true},
      page: {actions: [{id: 'submit', kind: 'submit', label: 'Submit application'}]}});
    let release, calls = 0;
    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(JSON.parse(options.body).input[1].content[0].text);
      if (request.fields) return {ok: true, json: async () => ({output_text: JSON.stringify({decisions: []})})};
      assert.ok(request.records.some(record => record.key === 'experience'), JSON.stringify(request));
      calls++;
      if (route === 'background' && calls === 1) return new Promise(resolve => {release = resolve;});
      return generatedResponse(drafts, 'Add relevant experience.');
    };
    if (route === 'background') harness.localData.openaiApiKey = 'synthetic-test-key';
    const started = await harness.dispatch({type: 'JOB_RUN_START', tabId: 7});
    assert.equal(started.ok, true, started.error);
    harness.localData.openaiApiKey = 'synthetic-test-key';
    if (route === 'panel') {
      const generated = await harness.dispatch({type: 'JOB_RUN_GENERATE_SUGGESTIONS', ...draftOrigin(started.run, {id: 'why', handle: 'doc-a:why'})});
      assert.equal(generated.ok, true, generated.error);
    } else await waitUntil(() => Boolean(release));
    const query = await harness.dispatch(inlineQuery({fieldId: 'why', handle: 'doc-a:why'}), inlineSender());
    assert.equal(query.ok, true, query.error);
    if (route === 'background') {
      const duplicate = await harness.dispatch(inlineGeneration(query), inlineSender());
      assert.equal(duplicate.ok, true, duplicate.error);
      assert.equal(duplicate.error, 'This answer is already being prepared');
      assert.equal(calls, 1);
      release(generatedResponse(drafts, 'Add relevant experience.'));
      await waitUntil(() => harness.sessionData.applicationRun['7'].aiOperations['suggestion:why'].status === 'completed');
    }
    const before = structuredClone(harness.sessionData.applicationRun['7']);
    const cached = await harness.dispatch(inlineGeneration(query, 'generate-cached'), inlineSender());
    assert.equal(cached.ok, true, cached.error);
    assert.equal(cached.generatedSuggestion.missingContext, 'Add relevant experience.');
    assert.equal(cached.candidates.find(candidate => candidate.kind === 'generated').answer, drafts[0].answer);
    assert.equal(calls, 1, route);
    assert.deepEqual(harness.sessionData.applicationRun['7'], before, 'inline cache reuse never rewrites run state');
  }
});

test('inline Generate defers to same-field background work queued behind the planner', async () => {
  const harness = await inlineHarness({waitForAI: false, field: {id: 'why', handle: 'doc-a:why', label: 'Why are you a good fit?', type: 'textarea', required: true},
    page: {actions: [{id: 'submit', kind: 'submit', label: 'Submit application'}]}});
  harness.localData.openaiApiKey = 'synthetic-test-key';
  let releasePlanner, draftCalls = 0;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(JSON.parse(options.body).input[1].content[0].text);
    if (request.fields) return new Promise(resolve => {releasePlanner = () => resolve({ok: true, json: async () => ({output_text: JSON.stringify({decisions: []})})});});
    draftCalls++;
    return generatedResponse([], 'Add relevant experience.');
  };
  await harness.dispatch({type: 'JOB_RUN_START', tabId: 7});
  await waitUntil(() => Boolean(releasePlanner));
  const query = await harness.dispatch(inlineQuery({fieldId: 'why', handle: 'doc-a:why'}), inlineSender());
  let generated;
  try { generated = await harness.dispatch(inlineGeneration(query), inlineSender()); }
  finally { releasePlanner(); }
  await waitUntil(() => harness.sessionData.applicationRun['7'].aiOperations.planner.status === 'completed');
  assert.equal(draftCalls, 1, 'planner release must not dispatch a second draft request for the inline field');
  assert.equal(generated.ok, true, generated.error);
  assert.equal(generated.error, 'This answer is already being prepared');
  const cached = await harness.dispatch(inlineGeneration(query, 'generate-after-planner'), inlineSender());
  assert.equal(cached.generatedSuggestion.missingContext, 'Add relevant experience.');
  assert.equal(draftCalls, 1);
});

test('queued draft ownership keeps two background fields concurrent and blocks a third queued field only', async () => {
  const harness = await inlineHarness({waitForAI: false, field: {id: 'why1', handle: 'doc-a:why1', label: 'Why are you a good fit?', type: 'textarea', required: true}});
  const page = harness.tabs.get(7).frames[0].pages[0];
  for (const id of ['why2', 'why3', 'optional']) page.fields.push({id, handle: `doc-a:${id}`, label: 'Why does this role interest you?', type: 'textarea', required: id !== 'optional', rawValue: '', editRevision: 0});
  harness.localData.openaiApiKey = 'synthetic-test-key';
  const releases = new Map();
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(JSON.parse(options.body).input[1].content[0].text);
    if (request.fields) return {ok: true, json: async () => ({output_text: JSON.stringify({decisions: []})})};
    calls.push(request.field.id);
    if (request.field.id === 'why1' || request.field.id === 'why2') return new Promise(resolve => {releases.set(request.field.id, () => resolve(generatedResponse([], 'Add relevant experience.')));});
    return generatedResponse([], 'Add relevant experience.');
  };
  await harness.dispatch({type: 'JOB_RUN_START', tabId: 7});
  await waitUntil(() => releases.size === 2);
  let generated, optional;
  try {
    assert.deepEqual(calls, ['why1', 'why2'], 'existing two-consumer concurrency is preserved');
    page.focusedFieldId = 'why3';
    const query = await harness.dispatch(inlineQuery({fieldId: 'why3', handle: 'doc-a:why3'}), inlineSender());
    generated = await harness.dispatch(inlineGeneration(query), inlineSender());
    page.focusedFieldId = 'optional';
    const other = await harness.dispatch(inlineQuery({fieldId: 'optional', handle: 'doc-a:optional', requestId: 'optional-query'}), inlineSender());
    optional = await harness.dispatch(inlineGeneration(other), inlineSender());
  } finally { for (const release of releases.values()) release(); }
  await waitUntil(() => harness.sessionData.applicationRun['7'].aiOperations.planner.status === 'completed');
  assert.equal(calls.filter(id => id === 'why3').length, 1);
  assert.equal(generated.error, 'This answer is already being prepared');
  assert.equal(optional.ok, true, optional.error);
  assert.equal(calls.filter(id => id === 'optional').length, 1, 'unrelated inline field can generate while background work is pending');
});

test('background retry does not dispatch a draft for a field already owned by inline Generate', async () => {
  const harness = await inlineHarness({waitForAI: false, field: {id: 'why', handle: 'doc-a:why', label: 'Why are you a good fit?', type: 'textarea', required: true},
    page: {actions: [{id: 'submit', kind: 'submit', label: 'Submit application'}]}});
  await harness.dispatch({type: 'JOB_RUN_START', tabId: 7});
  harness.localData.openaiApiKey = 'synthetic-test-key';
  let releaseInline, draftCalls = 0;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(JSON.parse(options.body).input[1].content[0].text);
    if (request.fields) return {ok: true, json: async () => ({output_text: JSON.stringify({decisions: []})})};
    draftCalls++;
    if (draftCalls === 1) return new Promise(resolve => {releaseInline = () => resolve(generatedResponse([], 'Add relevant experience.'));});
    return generatedResponse([], 'Add relevant experience.');
  };
  const query = await harness.dispatch(inlineQuery({fieldId: 'why', handle: 'doc-a:why'}), inlineSender());
  const pending = harness.dispatch(inlineGeneration(query), inlineSender());
  await waitUntil(() => Boolean(releaseInline));
  const run = harness.sessionData.applicationRun['7'];
  run.aiOperations = {planner: {status: 'failed'}, 'suggestion:why': {status: 'failed'}};
  try {
    await harness.dispatch({type: 'JOB_RUN_RETRY_AI', tabId: 7});
    await waitUntil(() => harness.sessionData.applicationRun['7'].aiOperations.planner.status === 'completed');
  } finally { releaseInline(); }
  assert.equal((await pending).ok, true);
  assert.equal(draftCalls, 1, 'the inline owner remains the only draft provider request');
});

test('unrelated background work stays pending through inline query and apply, then rejects changed page evidence', async () => {
  const harness = await inlineHarness({waitForAI: false, field: {label: 'Current CTC', type: 'textarea'},
    answerRecords: [{key: 'current_salary', question: 'Current salary', answer: 'Synthetic explanation', sensitivity: 'review'}]});
  const page = harness.tabs.get(7).frames[0].pages[0];
  page.fields.push({id: 'why', handle: 'doc-a:why', label: 'Why are you a good fit?', type: 'textarea', required: true, rawValue: '', editRevision: 0});
  harness.localData.openaiApiKey = 'synthetic-test-key';
  let release, calls = 0;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(JSON.parse(options.body).input[1].content[0].text);
    if (request.fields) return {ok: true, json: async () => ({output_text: JSON.stringify({decisions: []})})};
    calls++;
    return new Promise(resolve => {release = resolve;});
  };
  await harness.dispatch({type: 'JOB_RUN_START', tabId: 7});
  await waitUntil(() => Boolean(release));
  const runBefore = structuredClone(harness.sessionData.applicationRun['7']);
  const query = await harness.dispatch(inlineQuery(), inlineSender());
  assert.equal(query.ok, true, query.error);
  assert.deepEqual(harness.sessionData.applicationRun['7'], runBefore);
  const accepted = await harness.dispatch(inlineAcceptance(query), inlineSender());
  assert.equal(accepted.ok, true, accepted.error);
  assert.deepEqual(harness.sessionData.applicationRun['7'].aiOperations, runBefore.aiOperations);
  assert.equal(calls, 1);
  release(generatedResponse([], 'Add relevant experience.'));
  await waitUntil(() => harness.sessionData.applicationRun['7'].aiOperations['suggestion:why'].status === 'interrupted');
  assert.equal(harness.sessionData.applicationRun['7'].generatedSuggestions.why, undefined);
  assert.equal(page.values.name, 'Synthetic explanation');
});

test('worker restart interrupts actual pending inline work and rejects the old response', async () => {
  const harness = await inlineHarness({waitForAI: false});
  harness.localData.openaiApiKey = 'synthetic-test-key';
  let release;
  globalThis.fetch = () => new Promise(resolve => {release = resolve;});
  const query = await harness.dispatch(inlineQuery(), inlineSender());
  const pending = harness.dispatch(inlineGeneration(query), inlineSender());
  await waitUntil(() => Boolean(release));
  harness.listeners.length = 0;
  await import(`../src/service-worker.js?inline-pending-restart=${Date.now()}`);
  await waitUntil(() => harness.sessionData.inlineFieldSessions['7:0'].generation.status === 'interrupted');
  release(generatedResponse());
  assert.equal((await pending).ok, false);
  assert.equal(harness.sessionData.inlineFieldSessions['7:0'].generation.status, 'interrupted');
  assert.equal(harness.sessionData.inlineFieldSessions['7:0'].generatedSuggestions.name, undefined);
});

test('inline saved acceptance resolves worker candidate authority, persists once, and does not create a run', async () => {
  const harness = await inlineHarness();
  const query = await harness.dispatch(inlineQuery(), inlineSender());
  assert.equal(query.ok, true, query.error);
  const message = inlineAcceptance(query, {answer: 'Forged answer', sourceKey: 'foreign'});
  const [accepted, duplicate] = await Promise.all([harness.dispatch(message, inlineSender()), harness.dispatch(message, inlineSender())]);
  assert.equal(accepted.ok, true, accepted.error);
  assert.equal(duplicate.ok, false);
  assert.equal(harness.tabs.get(7).frames[0].pages[0].values.name, 'Nithin');
  const applies = harness.tabs.get(7).messages.filter(message => message.type === 'JOB_APP_APPLY');
  assert.equal(applies.length, 1);
  assert.equal(applies[0].applicationId, undefined);
  assert.equal(applies[0].decisions[0].expectedRawValue, '');
  assert.equal(applies[0].decisions[0].expectedEditRevision, 0);
  assert.equal(applies[0].approvalGuard.acceptanceToken, 'content-token');
  assert.equal(harness.sessionData.applicationRun?.['7'], undefined);
  assert.deepEqual(harness.sessionData.inlineFieldSessions['7:0'].suggestions, {});
  assert.equal((await harness.dispatch(message, inlineSender())).ok, false);
});

test('inline query rejects forged origins and malformed identity before inspection', async () => {
  const harness = await inlineHarness();
  for (const change of [{tabId: 8}, {frameId: 1}, {documentId: 'doc-b'}, {url: 'https://evil.test'}, {handle: ''}, {fieldId: 'x'.repeat(1001)}, {requestId: 'x'.repeat(201)}]) {
    const result = await harness.dispatch(inlineQuery(change), inlineSender());
    assert.equal(result.ok, false, JSON.stringify(change));
    assert.match(result.error, /origin|sender|handle|field|request/i);
  }
  for (const change of [{id: 'foreign'}, {id: undefined}, {tab: {id: -1}}, {frameId: '0'}, {url: 'file:///apply'}, {url: 'https://evil.test', origin: 'https://jobs.example.com'}]) {
    assert.equal((await harness.dispatch(inlineQuery(), inlineSender(change))).ok, false);
  }
  assert.equal(harness.tabs.get(7).messages.length, 0);
});

test('inline query excludes manual, legal, choice, utility and nonempty destinations', async () => {
  for (const field of [{type: 'checkbox'}, {type: 'select'}, {widget: 'custom'}, {type: 'password'}, {type: 'search'}, {label: 'I agree to terms and conditions'}, {labelConfidence: 'low'}, {rawValue: ' '}, {handle: ''}]) {
    const harness = await inlineHarness({field});
    assert.equal((await harness.dispatch(inlineQuery(), inlineSender())).ok, false, JSON.stringify(field));
    assert.equal(harness.tabs.get(7).messages.some(message => message.type === 'JOB_APP_APPLY'), false);
  }
  const harness = await inlineHarness({page: {focusedFieldId: null}});
  assert.equal((await harness.dispatch(inlineQuery(), inlineSender())).ok, false);
});

test('inline acceptance rejects changed document, descriptor, raw value, revision, URL and evidence', async () => {
  for (const scenario of ['document', 'handle', 'label', 'constraints', 'raw', 'revision', 'url', 'source-edit', 'source-delete', 'expired']) {
    const harness = await inlineHarness();
    const query = await harness.dispatch(inlineQuery(), inlineSender());
    assert.equal(query.ok, true, query.error);
    const page = harness.tabs.get(7).frames[0].pages[0];
    let sender = inlineSender();
    if (scenario === 'document') sender = inlineSender({documentId: 'doc-b'});
    if (scenario === 'handle') page.fields[0].handle = 'doc-b:name';
    if (scenario === 'label') page.fields[0].label = 'Different question';
    if (scenario === 'constraints') page.fields[0].constraints = {maxLength: 1};
    if (scenario === 'raw') page.fields[0].rawValue = ' ';
    if (scenario === 'revision') page.fields[0].editRevision++;
    if (scenario === 'url') page.url = 'https://jobs.example.com/other';
    if (scenario === 'source-edit') harness.localData.answerRecords[0].answer = 'Edited';
    if (scenario === 'source-delete') harness.localData.answerRecords = [];
    if (scenario === 'expired') harness.sessionData.inlineFieldSessions['7:0'].expiresAt = Date.now() - 1;
    const result = await harness.dispatch(inlineAcceptance(query), sender);
    assert.equal(result.ok, false, scenario);
    assert.equal(harness.tabs.get(7).messages.some(message => message.type === 'JOB_APP_APPLY'), false, scenario);
  }
});

test('inline worker-to-content race rejects type-then-erase immediately before write', async () => {
  const harness = await inlineHarness({page: {beforeApply: ({page}) => { page.fields[0].editRevision++; }}});
  const query = await harness.dispatch(inlineQuery(), inlineSender());
  assert.equal(query.ok, true, query.error);
  const before = JSON.stringify(harness.localData.answerRecords);
  const result = await harness.dispatch(inlineAcceptance(query), inlineSender());
  assert.equal(result.ok, false);
  assert.equal(harness.tabs.get(7).frames[0].pages[0].values?.name, undefined);
  assert.equal(JSON.stringify(harness.localData.answerRecords), before);
});

test('inline save failure reports applied but not saved and does not repeat the DOM write', async () => {
  const harness = await inlineHarness();
  const query = await harness.dispatch(inlineQuery(), inlineSender());
  assert.equal(query.ok, true, query.error);
  chrome.storage.local.set = async () => { throw new Error('storage unavailable'); };
  const result = await harness.dispatch(inlineAcceptance(query), inlineSender());
  assert.equal(result.ok, false);
  assert.match(result.error, /applied.*not.*sav/i);
  assert.equal(harness.tabs.get(7).frames[0].pages[0].values.name, 'Nithin');
  assert.equal((await harness.dispatch(inlineAcceptance(query), inlineSender())).ok, false);
  assert.equal(harness.tabs.get(7).messages.filter(message => message.type === 'JOB_APP_APPLY').length, 1);
});

test('inline sessions isolate identical field IDs in two frames and preserve unrelated live run', async () => {
  const pages = handle => [{page: {title: 'Job application', domain: 'jobs.example.com'}, fields: [{id: 'name', handle, label: 'Full name', type: 'text', rawValue: '', editRevision: 0}], actions: []}];
  const harness = await inlineHarness({pagesByTab: {7: {frames: [{frameId: 0, pages: pages('doc-a:name')}, {frameId: 2, pages: pages('doc-b:name')}]}}});
  harness.sessionData.applicationRun = {'7': {tabId: 7, startedAt: 'other-run', status: 'waiting_user', frame: {frameId: 9}, revision: 23, suggestions: {foreign: {}}}};
  const runBefore = JSON.stringify(harness.sessionData.applicationRun);
  const [first, second] = await Promise.all([
    harness.dispatch(inlineQuery(), inlineSender()),
    harness.dispatch(inlineQuery({handle: 'doc-b:name'}), inlineSender({frameId: 2, documentId: 'doc-b'})),
  ]);
  assert.equal(first.ok, true, first.error);
  assert.equal(second.ok, true, second.error);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal((await harness.dispatch(inlineAcceptance(first), inlineSender({frameId: 2, documentId: 'doc-b'}))).ok, false);
  assert.equal((await harness.dispatch(inlineAcceptance(second), inlineSender({frameId: 2, documentId: 'doc-b'}))).ok, true);
  assert.equal(harness.tabs.get(7).frames[0].pages[0].values?.name, undefined);
  assert.equal(JSON.stringify(harness.sessionData.applicationRun), runBefore);
});

test('all existing management and run endpoints require a trusted extension panel sender', async () => {
  const harness = await inlineHarness();
  const routes = ['JOB_RUN_APPROVE_SUGGESTION', 'JOB_RUN_APPLY_DRAFT', 'JOB_RUN_REWRITE_ANSWER', 'JOB_RUN_GENERATE_SUGGESTIONS', 'JOB_RUN_START', 'JOB_RUN_CHECK_PAGE', 'JOB_RUN_ADVANCE_PAGE', 'JOB_RUN_FOCUS_FIELD', 'JOB_RUN_SAVE_ANSWERS', 'JOB_RUN_VALIDATE_PAGE', 'JOB_RUN_RETRY_AI', 'JOB_RUN_SELECT_EMPLOYMENT', 'JOB_RUN_SEARCH_ANSWERS', 'JOB_RUN_STATE', 'JOB_DATASOURCE_STATE', 'JOB_DATASOURCE_EXPORT', 'JOB_DATASOURCE_IMPORT', 'JOB_DATASOURCE_CORRECT', 'JOB_DATASOURCE_SUPPRESS_ANSWER', 'JOB_DATASOURCE_DELETE_ANSWER', 'JOB_DATASOURCE_PROFILE_UPDATE', 'JOB_LEARNING_INBOX_RESOLVE'];
  for (const type of routes) {
    const result = await harness.dispatch({type, tabId: 7}, inlineSender());
    assert.equal(result.ok, false, type);
    assert.match(result.error, /extension panel/, type);
  }
  for (const sender of [{}, {id: 'foreign', url: chrome.runtime.getURL('sidepanel.html')}, {id: chrome.runtime.id, url: 'https://evil.test'}]) {
    assert.equal((await harness.dispatch({type: 'JOB_DATASOURCE_STATE'}, sender)).ok, false);
  }
  assert.equal((await harness.dispatch({type: 'JOB_DATASOURCE_STATE'})).ok, true);
  assert.equal((await harness.dispatch({type: 'JOB_RUN_STATE', tabId: 7})).ok, true);
});

test('inline acceptance rejects optional forged destination fields and unsupported numeric controls', async () => {
  for (const overrides of [{handle: 'other'}, {fieldId: 'other'}, {applicationId: 'foreign'}, {pageSignature: 'foreign'}, {handle: 'x'.repeat(1001)}]) {
    const harness = await inlineHarness();
    const query = await harness.dispatch(inlineQuery(), inlineSender());
    assert.equal(query.ok, true, query.error);
    const response = await harness.dispatch(inlineAcceptance(query, overrides), inlineSender());
    assert.equal(response.ok, false, JSON.stringify(overrides));
    assert.equal(harness.tabs.get(7).messages.some(message => message.type === 'JOB_APP_APPLY'), false);
  }
  const harness = await inlineHarness({field: {type: 'number'}});
  const response = await harness.dispatch(inlineQuery(), inlineSender());
  assert.equal(response.ok, false);
  assert.match(response.error, /manual/);
});

test('inline rechecks source evidence after the final asynchronous destination guard', async () => {
  const harness = await inlineHarness();
  const query = await harness.dispatch(inlineQuery(), inlineSender());
  assert.equal(query.ok, true, query.error);
  let inspections = 0;
  harness.tabs.get(7).frames[0].pages[0].onInlineInspect = () => {
    if (++inspections === 2) harness.localData.answerRecords[0].answer = 'Changed during approval';
  };
  const response = await harness.dispatch(inlineAcceptance(query), inlineSender());
  assert.equal(response.ok, false);
  assert.equal(harness.tabs.get(7).messages.some(message => message.type === 'JOB_APP_APPLY'), false);
});

for (const revocation of ['JOB_INLINE_CANCEL', 'JOB_RUN_START']) {
  test(`inline ${revocation} during final evidence read prevents apply dispatch`, {timeout: 5000}, async () => {
    const harness = await inlineHarness();
    const query = await harness.dispatch(inlineQuery(), inlineSender());
    assert.equal(query.ok, true, query.error);
    let inspections = 0;
    let readsAfterFinalInspection = 0;
    let entered;
    let resume;
    const waiting = new Promise(resolve => {entered = resolve;});
    const gate = new Promise(resolve => {resume = resolve;});
    harness.tabs.get(7).frames[0].pages[0].onInlineInspect = () => {inspections++;};
    const getLocal = chrome.storage.local.get;
    chrome.storage.local.get = async defaults => {
      // The final guard first scopes the live field; its next evidence read is inside applyReviewedField.
      if (inspections === 2 && Object.hasOwn(defaults, 'answerRecords') && ++readsAfterFinalInspection === 2) {
        entered();
        await gate;
      }
      return getLocal(defaults);
    };
    const accepting = harness.dispatch(inlineAcceptance(query), inlineSender());
    await waiting;
    let revoked;
    if (revocation === 'JOB_INLINE_CANCEL') {
      revoked = await harness.dispatch({type: revocation, sessionId: query.sessionId, requestId: 'cancel-final-read'}, inlineSender());
      assert.equal(revoked.ok, true, revoked.error);
    } else {
      let invalidated;
      const invalidation = new Promise(resolve => {invalidated = resolve;});
      const setSession = chrome.storage.session.set;
      chrome.storage.session.set = async values => {
        await setSession(values);
        if (values.inlineFieldSessions && !values.inlineFieldSessions['7:0']) invalidated();
      };
      revoked = harness.dispatch({type: revocation, tabId: 7});
      await invalidation;
    }
    assert.equal(harness.sessionData.inlineFieldSessions['7:0'], undefined);
    resume();
    assert.equal((await revoked).ok, true);
    const response = await accepting;
    assert.equal(harness.tabs.get(7).messages.some(message => message.type === 'JOB_APP_APPLY'), false);
    assert.equal(response.ok, false);
    assert.match(response.error, /session|expired|revok|changed/i);
    assert.equal(harness.tabs.get(7).frames[0].pages[0].values?.name, undefined);
  });
}

test('inline cancellation during content reinjection prevents apply retry dispatch', async () => {
  const harness = await inlineHarness();
  const query = await harness.dispatch(inlineQuery(), inlineSender());
  assert.equal(query.ok, true, query.error);
  const sendMessage = chrome.tabs.sendMessage;
  let failed = false;
  chrome.tabs.sendMessage = async (tabId, message, options) => {
    if (message.type === 'JOB_APP_APPLY' && !failed) {failed = true; throw new Error('Content receiver unavailable');}
    return sendMessage(tabId, message, options);
  };
  const executeScript = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    const cancelled = await harness.dispatch({type: 'JOB_INLINE_CANCEL', sessionId: query.sessionId, requestId: 'cancel-retry'}, inlineSender());
    assert.equal(cancelled.ok, true, cancelled.error);
    return executeScript(details);
  };
  const response = await harness.dispatch(inlineAcceptance(query), inlineSender());
  assert.equal(failed, true);
  assert.equal(harness.tabs.get(7).messages.some(message => message.type === 'JOB_APP_APPLY'), false);
  assert.equal(response.ok, false);
});

test('inline cancellation and lifecycle events revoke sessions without losing other frames', async () => {
  for (const event of ['cancel', 'navigation', 'loading', 'removed', 'start']) {
    const harness = await inlineHarness();
    const query = await harness.dispatch(inlineQuery(), inlineSender());
    assert.equal(query.ok, true, query.error);
    harness.sessionData.inlineFieldSessions['7:2'] = {...structuredClone(harness.sessionData.inlineFieldSessions['7:0']), sessionId: 'second-frame', frameId: 2, documentId: 'second-document'};
    if (event === 'cancel') {
      const cancel = {type: 'JOB_INLINE_CANCEL', sessionId: query.sessionId, requestId: 'cancel-1'};
      assert.equal((await harness.dispatch(cancel, inlineSender({documentId: 'foreign'}))).ok, false);
      assert.equal((await harness.dispatch(cancel, inlineSender())).ok, true);
    }
    if (event === 'navigation') await harness.dispatch({type: 'JOB_APP_NAVIGATED'}, inlineSender());
    if (event === 'loading') harness.updatedListeners[0](7, {status: 'loading'});
    if (event === 'removed') harness.removedListeners[0](7);
    if (event === 'start') await harness.dispatch({type: 'JOB_RUN_START', tabId: 7});
    const response = await harness.dispatch(inlineAcceptance(query), inlineSender());
    assert.equal(response.ok, false, event);
    assert.equal(harness.sessionData.inlineFieldSessions['7:0'], undefined, event);
    assert.equal(Boolean(harness.sessionData.inlineFieldSessions['7:2']), ['cancel', 'navigation'].includes(event));
  }
});

test('inline concurrent queries commit only the newest request and navigation revokes pending lookup', async () => {
  for (const invalidate of ['query', 'navigation']) {
    const harness = await inlineHarness();
    let started;
    let release;
    const inspected = new Promise(resolve => {started = resolve;});
    const gate = new Promise(resolve => {release = resolve;});
    let inspections = 0;
    harness.tabs.get(7).frames[0].pages[0].onInlineInspect = async () => {if (++inspections === 1) {started(); await gate;}};
    const old = harness.dispatch(inlineQuery(), inlineSender());
    await inspected;
    let current;
    if (invalidate === 'query') current = await harness.dispatch(inlineQuery({requestId: 'query-2'}), inlineSender());
    else await harness.dispatch({type: 'JOB_APP_NAVIGATED'}, inlineSender());
    release();
    assert.equal((await old).ok, false);
    if (current) {
      assert.equal(current.ok, true, current.error);
      assert.equal(harness.sessionData.inlineFieldSessions['7:0'].sessionId, current.sessionId);
      assert.equal(current.requestId, 'query-2');
    } else assert.equal(harness.sessionData.inlineFieldSessions['7:0'], undefined);
  }
});

test('inline completed sessions survive worker restart and foreign pending generation is interrupted', async () => {
  const harness = await inlineHarness();
  const query = await harness.dispatch(inlineQuery(), inlineSender());
  assert.equal(query.ok, true, query.error);
  const session = harness.sessionData.inlineFieldSessions['7:0'];
  session.generation = {status: 'pending', requestId: 'foreign-generation'};
  session.workerId = 'foreign-worker';
  harness.listeners.length = 0;
  await import(`../src/service-worker.js?test=inline-restart-${Date.now()}`);
  const response = await harness.dispatch(inlineAcceptance(query), inlineSender());
  assert.equal(response.ok, true, response.error);
  assert.equal(harness.sessionData.inlineFieldSessions['7:0'].generation.status, 'interrupted');
});

test('inline compatible run acceptance uses real learning identity and refreshes current run without overwriting concurrent changes', async () => {
  const harness = await inlineHarness({field: {label: 'Current CTC', type: 'textarea'},
    answerRecords: [{key: 'current_salary', question: 'Current salary', answer: 'Synthetic explanation', confirmationState: 'confirmed', sensitivity: 'review'}],
    page: {actions: [{id: 'submit', label: 'Submit application', kind: 'submit'}]}});
  const started = await harness.dispatch({type: 'JOB_RUN_START', tabId: 7});
  assert.equal(started.ok, true, started.error);
  const query = await harness.dispatch(inlineQuery(), inlineSender());
  assert.equal(query.ok, true, query.error);
  assert.equal(harness.sessionData.inlineFieldSessions['7:0'].attachedRun.applicationId, started.run.startedAt);
  harness.tabs.get(7).frames[0].pages[0].beforeApply = () => {
    harness.sessionData.applicationRun['7'] = {...harness.sessionData.applicationRun['7'], concurrentMarker: 'preserve this', revision: 500};
  };
  const response = await harness.dispatch(inlineAcceptance(query), inlineSender());
  assert.equal(response.ok, true, response.error);
  assert.equal(harness.tabs.get(7).messages.filter(message => message.type === 'JOB_APP_APPLY').at(-1).applicationId, started.run.startedAt);
  assert.equal(harness.sessionData.applicationRun['7'].concurrentMarker, 'preserve this');
  assert.ok(harness.sessionData.applicationRun['7'].revision > 500);
  assert.equal(harness.sessionData.applicationRun['7'].suggestions.name, undefined);
  assert.equal(harness.tabs.get(7).nextClicks, 0);
  assert.equal(harness.tabs.get(7).submitCalls, 0);
});

test('inline unresolved employment asks to choose employer instead of borrowing another frame mapping', async () => {
  const harness = await inlineHarness({field: {label: 'Job title', entityType: 'employment', entityId: 'work-1'}});
  harness.localData.profile = {employment: [{id: 'employer-a', company: 'Company A'}, {id: 'employer-b', company: 'Company B'}]};
  harness.sessionData.applicationRun = {'7': {tabId: 7, startedAt: 'other', status: 'waiting_user', frame: {frameId: 9}, employmentMappings: {'work-1': 'employer-a'}}};
  const query = await harness.dispatch(inlineQuery(), inlineSender());
  assert.equal(query.ok, true, query.error);
  assert.deepEqual(query.candidates, []);
  assert.match(query.error, /Choose the employer/);
  assert.equal(harness.sessionData.inlineFieldSessions['7:0'].attachedRun, null);
});

test('inline compatible run attachment uses the live field identity without requiring a listed run field', async () => {
  const harness = await inlineHarness({field: {label: 'Current CTC', type: 'textarea'},
    answerRecords: [{key: 'current_salary', question: 'Current salary', answer: 'Synthetic explanation', confirmationState: 'confirmed', sensitivity: 'review'}],
    page: {actions: [{id: 'submit', label: 'Submit application', kind: 'submit'}]}});
  const started = await harness.dispatch({type: 'JOB_RUN_START', tabId: 7});
  const run = harness.sessionData.applicationRun['7'];
  run.suggestions = {};
  run.generatedSuggestions = {};
  run.actionRequired = [];
  run.optionalUnresolved = [];
  const query = await harness.dispatch(inlineQuery(), inlineSender());
  assert.equal(query.ok, true, query.error);
  assert.equal(harness.sessionData.inlineFieldSessions['7:0'].attachedRun?.applicationId, started.run.startedAt);
  const response = await harness.dispatch(inlineAcceptance(query), inlineSender());
  assert.equal(response.ok, true, response.error);
});

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
  const sentDecisions = harness.tabs.get(7).messages.find(message => message.type === 'JOB_APP_APPLY')?.decisions || [];
  assert.equal(sentDecisions.some(decision => decision.fieldId === 'ctc' && decision.action === 'fill'), false);
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

test('planner failure preserves diagnostics while required suggestion preparation continues', async () => {
  const harness = createHarness({ pagesByTab: { 7: { pages: [{ fields: [{ id: 'unknown', label: 'Describe underwater welding', type: 'text', required: true }], actions: [{ id: 'submit', label: 'Submit application', kind: 'submit' }] }] } } });
  harness.localData.openaiApiKey = 'synthetic-key';
  const bodies = [];
  globalThis.fetch = async (_url, options) => { bodies.push(JSON.parse(options.body)); throw new Error('Synthetic network failure'); };
  await import(`../src/service-worker.js?test=bounded-${Date.now()}`);
  const first = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  assert.deepEqual(JSON.parse(bodies[0].input[1].content[0].text).records, []);
  assert.match(first.run.llmError, /Synthetic network failure/);
  await harness.dispatch({ type: 'JOB_RUN_CHECK_PAGE', tabId: 7 });
  assert.equal(bodies.length, 2);
});

test('Retry AI reruns only failed work and keeps completed drafts', async () => {
  const harness = createHarness({ answerRecords: [{
    key: 'experience', question: 'Experience', answer: 'Built reliable event processing services.', confirmationState: 'confirmed', sensitivity: 'safe',
  }], pagesByTab: { 7: { pages: [{
    fields: [{ id: 'why', handle: 'why-handle', label: 'Why are you a good fit?', type: 'textarea', required: true }],
    actions: [{ id: 'submit', label: 'Submit application', kind: 'submit' }],
  }] } } });
  harness.localData.openaiApiKey = 'synthetic-key';
  let initialRequests = 0;
  globalThis.fetch = async (_url, options) => {
    initialRequests += 1;
    const request = JSON.parse(JSON.parse(options.body).input[1].content[0].text);
    if (request.fields) throw new Error('planner is temporarily unavailable');
    return {
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ output_text: JSON.stringify({ suggestions: [{ answer: 'A reviewed draft.', evidenceKeys: ['experience'] }], missingContext: '' }) }),
    };
  };
  await import(`../src/service-worker.js?retry-completed=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  assert.equal(initialRequests, 2);
  assert.equal(started.run.aiOperations.planner.status, 'failed');
  assert.equal(started.run.aiOperations['suggestion:why'].status, 'completed');
  assert.equal(started.run.generatedSuggestions.why.suggestions[0].answer, 'A reviewed draft.');

  let retryRequests = 0;
  globalThis.fetch = async (_url, options) => {
    retryRequests += 1;
    const request = JSON.parse(JSON.parse(options.body).input[1].content[0].text);
    assert.ok(request.fields, 'only the failed planner operation should rerun');
    return {
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ output_text: JSON.stringify({ decisions: [{
        fieldId: 'why', action: 'ask_user', value: null, evidenceKeys: [], confidence: 'low', sensitivity: 'safe', reason: 'Keep the completed draft', transformation: null,
      }] }) }),
    };
  };
  const retried = await harness.dispatch({ type: 'JOB_RUN_RETRY_AI', tabId: 7 });
  assert.equal(retryRequests, 1);
  assert.equal(retried.run.aiOperations.planner.status, 'completed');
  assert.equal(retried.run.generatedSuggestions.why.suggestions[0].answer, 'A reviewed draft.');
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

test('choice evidence stays unresolved until the planner proposes a reviewed visible label', async () => {
  const harness = createHarness({ answerRecords: [{
    key: 'how_did_you_hear_about_us',
    question: 'How did you hear about us?',
    answer: 'A recruiter contacted me',
    confirmationState: 'confirmed',
    sensitivity: 'safe',
  }], pagesByTab: { 7: { pages: [{ fields: [
    { id: 'heard', handle: 'heard-handle', label: 'How did you hear about us?', type: 'select', required: true, options: ['Recruiter', 'Company website'] },
  ], actions: [{ id: 'submit', label: 'Submit application', kind: 'submit' }] }] } } });
  harness.localData.openaiApiKey = 'synthetic-choice-planner-key';
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ output_text: JSON.stringify({ decisions: [{
        fieldId: 'heard', action: 'fill', value: 'Recruiter', evidenceKeys: ['how_did_you_hear_about_us'],
        confidence: 'high', sensitivity: 'safe', reason: 'The saved source describes recruiter outreach', transformation: 'map_option',
      }] }) }),
    };
  };
  await import(`../src/service-worker.js?choice-planner-${Date.now()}`);

  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });

  assert.equal(started.ok, true, started.error);
  assert.equal(bodies.length, 1, 'the non-label saved answer must reach the planner');
  const suggestion = started.run.suggestions?.heard;
  assert.ok(suggestion, JSON.stringify(started.run));
  assert.equal(suggestion.candidates[0].answer, 'Recruiter');
  assert.equal(suggestion.candidates[0].kind, 'planner');
  assert.equal(harness.tabs.get(7).frames[0].pages[0].values?.heard, undefined);
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

test('bounded fill loop reinspects and fills a supported conditional field', async () => {
  const harness = createHarness({
    waitForAI: false,
    answerRecords: [
      { key: 'country', question: 'Country', answer: 'India', sensitivity: 'safe' },
      { key: 'city', question: 'City', answer: 'Pune', sensitivity: 'safe' },
    ],
    pagesByTab: {
      7: {
        pages: [{
          fields: [{ id: 'country', label: 'Country', type: 'text', required: true }],
          onApply: ({ page, decisions }) => {
            if (decisions.some((decision) => decision.fieldId === 'country' && decision.action === 'fill')) {
              page.fields.push({ id: 'city', label: 'City', type: 'text', required: true });
            }
          },
          actions: [{ id: 'submit', label: 'Submit application', kind: 'submit' }],
        }],
      },
    },
  });

  await import(`../src/service-worker.js?conditional-loop=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });

  assert.equal(started.ok, true, started.error);
  assert.equal(harness.tabs.get(7).frames[0].pages[0].values.country, 'India');
  assert.equal(harness.tabs.get(7).frames[0].pages[0].values.city, 'Pune');
  assert.equal(harness.tabs.get(7).messages.filter((message) => message.type === 'JOB_APP_APPLY').length, 2);
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

test('worker keeps empty optional sensitive fields under optional unanswered', async () => {
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
  assert.equal(started.run.optionalUnresolved.some((item) => item.fieldId === 'cover_letter'), true);
  assert.equal(started.run.audit.some((item) => item.key === 'full_name'), true);
  assert.equal(started.run.actionRequired.find((item) => item.fieldId === 'work_authorization').formOrder, 1);
  assert.equal(started.run.optionalUnresolved.find((item) => item.fieldId === 'portfolio').formOrder, 2);
  assert.equal(started.run.optionalUnresolved.find((item) => item.fieldId === 'cover_letter').formOrder, 3);
  assert.equal(started.run.optionalUnresolved.find((item) => item.fieldId === 'cover_letter').pageNumber, 1);
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

test('final site submission saves the supplied snapshot without recapturing or submitting the page', async () => {
  const harness = createHarness({
    pagesByTab: {
      7: {
        pages: [{
          fields: [
            { id: 'full_name', label: 'Full name', type: 'text', required: true },
            { id: 'portfolio_url', label: 'Portfolio URL', type: 'url', required: false, currentValue: 'https://example.com/nithin' },
          ],
          actions: [{ id: 'action_0', label: 'Submit application', kind: 'submit', type: 'submit' }],
        }],
      },
    },
  });

  await import(`../src/service-worker.js?final-submit=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  const beforeMessages = harness.tabs.get(7).messages.length;
  const snapshot = {
    type: 'JOB_APP_FINAL_SUBMISSION',
    applicationId: started.run.startedAt,
    page: { title: 'Application', domain: 'jobs.example.com' },
    records: [
      { key: 'full_name', question: 'Full name', answer: 'Nithin', type: 'text', sensitivity: 'safe', provenance: 'autofill' },
      { key: 'portfolio_url', question: 'Portfolio URL', answer: 'https://example.com/nithin', type: 'url', sensitivity: 'safe', provenance: 'user' },
    ],
  };

  const rejected = await harness.dispatch({ ...snapshot, applicationId: 'stale-run' }, { tab: { id: 7 }, frameId: 0, url: 'https://jobs.example.com/apply' });
  const wrongFrame = await harness.dispatch(snapshot, { tab: { id: 7 }, frameId: 1, url: 'https://jobs.example.com/apply' });
  const saved = await harness.dispatch(snapshot, { tab: { id: 7 }, frameId: 0, url: 'https://jobs.example.com/apply' });
  const duplicate = await harness.dispatch(snapshot, { tab: { id: 7 }, frameId: 0, url: 'https://jobs.example.com/apply' });

  assert.equal(rejected.ok, false);
  assert.equal(wrongFrame.ok, false);
  assert.equal(saved.ok, true);
  assert.equal(saved.run.status, 'answers_saved');
  assert.equal(duplicate.ok, true);
  assert.equal(harness.localData.applicationDrafts[`${7}:${started.run.startedAt}`].records.some((record) => record.key === 'portfolio_url'), true);
  assert.equal(harness.localData.learningInbox.filter((item) => item.candidate.id === 'portfolio_url').length, 1);
  assert.equal(harness.tabs.get(7).messages.slice(beforeMessages).some((message) => message.type === 'JOB_APP_CAPTURE'), false);
  assert.equal(harness.tabs.get(7).submitCalls, 0);
  assert.equal(harness.tabs.get(7).messages.some((message) => message.type === 'JOB_APP_SUBMIT'), false);
});

test('final submission waits for a concurrent manual save instead of dropping its snapshot', async () => {
  const harness = createHarness({
    pagesByTab: { 7: { pages: [{
      fields: [{ id: 'full_name', label: 'Full name', type: 'text', required: true }],
      actions: [{ id: 'action_0', label: 'Submit application', kind: 'submit', type: 'submit' }],
    }] } },
  });

  await import(`../src/service-worker.js?final-save-queue=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  const snapshot = {
    type: 'JOB_APP_FINAL_SUBMISSION',
    applicationId: started.run.startedAt,
    page: { title: 'Application', domain: 'jobs.example.com' },
    records: [{ key: 'full_name', question: 'Full name', answer: 'Nithin', type: 'text', sensitivity: 'safe', provenance: 'user' }],
  };

  const originalSendMessage = chrome.tabs.sendMessage;
  let releaseCapture;
  let captureHeld = false;
  const captureStarted = new Promise((resolve) => {
    chrome.tabs.sendMessage = async (tabId, message, options) => {
      if (message.type === 'JOB_APP_CAPTURE' && !captureHeld) {
        captureHeld = true;
        resolve();
        await new Promise((done) => { releaseCapture = done; });
      }
      return originalSendMessage(tabId, message, options);
    };
  });
  const manualSave = harness.dispatch({ type: 'JOB_RUN_SAVE_ANSWERS', tabId: 7 });
  await captureStarted;
  const finalSave = harness.dispatch(snapshot, { tab: { id: 7 }, frameId: 0, url: 'https://jobs.example.com/apply' });
  releaseCapture();
  const [manual, final] = await Promise.all([manualSave, finalSave]);

  assert.equal(manual.ok, true, manual.error);
  assert.equal(final.ok, true, final.error);
  assert.equal(final.skipped, undefined);
  assert.equal(final.run.status, 'answers_saved');
});

test('persists an accepted final snapshot when navigation interrupts a manual save', async () => {
  const harness = createHarness({
    pagesByTab: { 7: { pages: [{
      fields: [{ id: 'full_name', label: 'Full name', type: 'text', required: true }],
      actions: [{ id: 'action_0', label: 'Submit application', kind: 'submit', type: 'submit' }],
    }] } },
  });

  await import(`../src/service-worker.js?final-save-navigation=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  const snapshot = {
    type: 'JOB_APP_FINAL_SUBMISSION',
    applicationId: started.run.startedAt,
    page: { title: 'Application', domain: 'jobs.example.com' },
    records: [{ key: 'full_name', question: 'Full name', answer: 'Edited at submit', type: 'text', sensitivity: 'safe', provenance: 'user' }],
  };

  const originalSendMessage = chrome.tabs.sendMessage;
  let releaseCapture;
  let captureHeld = false;
  const captureStarted = new Promise((resolve) => {
    chrome.tabs.sendMessage = async (tabId, message, options) => {
      if (message.type === 'JOB_APP_CAPTURE' && !captureHeld) {
        captureHeld = true;
        resolve();
        await new Promise((done) => { releaseCapture = done; });
      }
      return originalSendMessage(tabId, message, options);
    };
  });
  const manualSave = harness.dispatch({ type: 'JOB_RUN_SAVE_ANSWERS', tabId: 7 });
  await captureStarted;
  const finalSave = harness.dispatch(snapshot, { tab: { id: 7 }, frameId: 0, url: 'https://jobs.example.com/apply' });
  harness.tabs.get(7).frames = [];
  releaseCapture();
  const [manual, final] = await Promise.all([manualSave, finalSave]);

  assert.equal(manual.ok, false);
  assert.equal(final.ok, true, final.error);
  assert.equal(final.run.status, 'answers_saved');
  assert.equal(harness.localData.applicationDrafts[`${7}:${started.run.startedAt}`].records.find((record) => record.key === 'full_name').answer, 'Edited at submit');
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

test('saved-answer feedback suppresses one destination and deletion removes the selected record', async () => {
  const harness = createHarness({
    answerRecords: [
      { key: 'deployment_story', question: 'Model deployment project', answer: 'I trained machine learning models and deployed them to production.', confirmationState: 'confirmed', sensitivity: 'safe' },
      { key: 'unwanted_story', question: 'Machine learning project', answer: 'I developed machine learning services for production use.', confirmationState: 'confirmed', sensitivity: 'safe' },
    ],
    pagesByTab: { 7: { pages: [{ page: { title: 'Application' }, fields: [{ id: 'ml', handle: 'ml-handle', label: 'Describe your ML experience', type: 'textarea', required: true }], actions: [{ id: 'submit', label: 'Submit application', kind: 'submit' }] }] } },
  });
  await import(`../src/service-worker.js?test=saved-answer-feedback-${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  assert.ok(started.run.suggestions.ml.candidates.some(candidate => candidate.sourceKey === 'deployment_story'));

  const suppressed = await harness.dispatch({ type: 'JOB_DATASOURCE_SUPPRESS_ANSWER', tabId: 7, fieldId: 'ml', sourceKey: 'deployment_story' });
  assert.equal(suppressed.ok, true, suppressed.error);
  assert.deepEqual(harness.localData.answerRecords.find(record => record.key === 'deployment_story').suppressedFor, ['describe your ml experience|textarea']);
  assert.equal(suppressed.run.suggestions.ml.candidates.some(candidate => candidate.sourceKey === 'deployment_story'), false);

  const deleted = await harness.dispatch({ type: 'JOB_DATASOURCE_DELETE_ANSWER', tabId: 7, fieldId: 'ml', sourceKey: 'unwanted_story' });
  assert.equal(deleted.ok, true, deleted.error);
  assert.equal(harness.localData.answerRecords.some(record => record.key === 'unwanted_story'), false);
  assert.equal(deleted.run.suggestions?.ml?.candidates.some(candidate => candidate.sourceKey === 'unwanted_story') || false, false);
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

test('a late on-demand AI suggestion cannot overwrite a changed field destination', async () => {
  const harness = createHarness({ waitForAI: false, pagesByTab: { 7: { pages: [{
    page: { title: 'Application', domain: 'example.test' },
    fields: [{ id: 'why', handle: 'why-original', label: 'Why are you a good fit?', type: 'textarea', required: true }],
    actions: [{ id: 'next', label: 'Next', kind: 'next' }],
  }] } } });
  await import(`../src/service-worker.js?late-on-demand=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  harness.localData.aiProvider = 'openai';
  harness.localData.openaiApiKey = 'synthetic-test-key';

  let requestStarted;
  const requestStartedPromise = new Promise((resolve) => { requestStarted = resolve; });
  let releaseResponse;
  globalThis.fetch = async () => {
    requestStarted();
    return new Promise((resolve) => { releaseResponse = () => resolve({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ output_text: JSON.stringify({ suggestions: [{ answer: 'A grounded draft.', evidenceKeys: [] }], missingContext: '' }) }),
    }); });
  };

  const pending = harness.dispatch({ type: 'JOB_RUN_GENERATE_SUGGESTIONS', ...draftOrigin(started.run, { id: 'why', handle: 'why-original' }) });
  await requestStartedPromise;
  harness.tabs.get(7).frames[0].pages[0].fields[0].handle = 'why-replaced';
  releaseResponse();

  const response = await pending;
  assert.equal(response.ok, false);
  assert.match(response.error, /page or supporting evidence changed|destination changed/i);
  assert.equal(harness.sessionData.applicationRun['7'].generatedSuggestions?.why, undefined);
});

test('on-demand AI accepts an empty optional job description', async () => {
  const harness = createHarness({ waitForAI: false, pagesByTab: { 7: { pages: [{
    page: { title: 'Application', domain: 'example.test' },
    fields: [{ id: 'why', handle: 'why-handle', label: 'Why are you a good fit?', type: 'textarea', required: true }],
    actions: [{ id: 'submit', label: 'Submit application', kind: 'submit' }],
  }] } } });
  await import(`../src/service-worker.js?empty-job-context=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  harness.localData.aiProvider = 'openai';
  harness.localData.openaiApiKey = 'synthetic-test-key';
  globalThis.fetch = async () => ({
    ok: true, status: 200, statusText: 'OK',
    json: async () => ({ output_text: JSON.stringify({ suggestions: [], missingContext: 'Add a relevant example.' }) }),
  });

  const response = await harness.dispatch({
    type: 'JOB_RUN_GENERATE_SUGGESTIONS',
    ...draftOrigin(started.run, { id: 'why', handle: 'why-handle' }),
    jobDescription: '',
  });

  assert.equal(response.ok, true, response.error);
  assert.equal(response.run.generatedSuggestions.why.missingContext, 'Add a relevant example.');
});

test('on-demand AI cannot replace a run updated while validation is pending', async () => {
  let validationStarted;
  const validationStartedPromise = new Promise((resolve) => { validationStarted = resolve; });
  let releaseValidation;
  const validationReleasePromise = new Promise((resolve) => { releaseValidation = resolve; });
  let holdValidation = false;
  const harness = createHarness({ waitForAI: false, pagesByTab: { 7: { pages: [{
    page: { title: 'Application', domain: 'example.test' },
    fields: [{ id: 'why', handle: 'why-handle', label: 'Why are you a good fit?', type: 'textarea', required: true }],
    actions: [{ id: 'submit', label: 'Submit application', kind: 'submit' }],
    onValidate: async () => {
      if (holdValidation) {
        validationStarted();
        await validationReleasePromise;
      }
    },
  }] } } });
  await import(`../src/service-worker.js?stale-on-demand-save=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  harness.localData.aiProvider = 'openai';
  harness.localData.openaiApiKey = 'synthetic-test-key';
  globalThis.fetch = async () => ({
    ok: true, status: 200, statusText: 'OK',
    json: async () => ({ output_text: JSON.stringify({ suggestions: [], missingContext: 'Add a relevant example.' }) }),
  });

  holdValidation = true;
  const pending = harness.dispatch({
    type: 'JOB_RUN_GENERATE_SUGGESTIONS',
    ...draftOrigin(started.run, { id: 'why', handle: 'why-handle' }),
  });
  await validationStartedPromise;
  const current = harness.sessionData.applicationRun['7'];
  harness.sessionData.applicationRun['7'] = { ...current, revision: current.revision + 1, waitingFor: 'newer_update' };
  releaseValidation();

  const response = await pending;
  assert.equal(response.ok, false);
  assert.match(response.error, /page or supporting evidence changed/i);
  assert.equal(harness.sessionData.applicationRun['7'].waitingFor, 'newer_update');
  assert.equal(harness.sessionData.applicationRun['7'].generatedSuggestions?.why, undefined);
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

test('reviewed fills wait for DOM retention and generated drafts do not write reusable records', async () => {
  const retained = createHarness({ answerRecords: [{
    key: 'profile_statement', question: 'Profile statement', answer: 'I delivered reliable data products.', aliases: [], confirmationState: 'confirmed', sensitivity: 'safe', type: 'textarea',
  }], pagesByTab: { 7: { pages: [{
    page: { title: 'Application', domain: 'example.test' },
    fields: [{ id: 'profile', handle: 'profile-h', label: 'Profile statement', type: 'textarea', required: true }],
    actions: [{ id: 'submit', label: 'Submit application', kind: 'submit' }],
    onApply: ({ page }) => { delete page.values.profile; },
  }] } } });
  await import(`../src/service-worker.js?retention-before-save=${Date.now()}`);
  const started = await retained.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  const suggestion = started.run.suggestions?.profile;
  assert.ok(suggestion, JSON.stringify(started.run));
  const beforeRetentionFailure = structuredClone(retained.localData.answerRecords);
  const failed = await retained.dispatch({
    type: 'JOB_RUN_APPROVE_SUGGESTION', tabId: 7, frameId: suggestion.frameId,
    applicationId: suggestion.applicationId, pageSignature: suggestion.pageSignature,
    fieldId: 'profile', handle: suggestion.field.handle, sourceKey: 'profile_statement',
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /did not retain/i);
  assert.deepEqual(retained.localData.answerRecords, beforeRetentionFailure);

  const drafts = createHarness({ pagesByTab: { 7: { pages: [{
    page: { title: 'Application', domain: 'example.test' },
    fields: [{ id: 'summary', handle: 'summary-h', label: 'Why are you a good fit?', type: 'textarea', required: true }], actions: [{ id: 'submit', label: 'Submit application', kind: 'submit' }],
  }] } } });
  await import(`../src/service-worker.js?generated-draft-apply=${Date.now()}`);
  const draftRun = await drafts.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  drafts.localData.openaiApiKey = 'synthetic-test-key';
  globalThis.fetch = async () => ({
    ok: true, status: 200, statusText: 'OK',
    json: async () => ({ output_text: JSON.stringify({ suggestions: [{ answer: 'I build reliable systems that fit this role.', evidenceKeys: [] }], missingContext: '' }) }),
  });
  const generated = await drafts.dispatch({ type: 'JOB_RUN_GENERATE_SUGGESTIONS', ...draftOrigin(draftRun.run, { id: 'summary', handle: 'summary-h' }) });
  assert.equal(generated.ok, true, generated.error);
  const recordsBeforeDraft = structuredClone(drafts.localData.answerRecords);
  const applied = await drafts.dispatch({
    type: 'JOB_RUN_APPLY_DRAFT', ...draftOrigin(generated.run, { id: 'summary', handle: 'summary-h' }),
    answer: generated.run.generatedSuggestions.summary.suggestions[0].answer,
  });
  assert.equal(applied.ok, true, applied.error);
  assert.deepEqual(drafts.localData.answerRecords, recordsBeforeDraft);
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

test('worker uses the selected Fireworks key and default model for planner requests', async () => {
  const harness = createHarness({
    pagesByTab: { 7: { pages: [{ fields: [{ id: 'unknown', label: 'Describe underwater welding', type: 'text', required: true }], actions: [{ id: 'submit', label: 'Submit application', kind: 'submit' }] }] } },
  });
  harness.localData.aiProvider = 'fireworks';
  harness.localData.fireworksApiKey = 'synthetic-fireworks-key';
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body, authorization: options.headers.Authorization });
    const prompt = body.messages[1].content;
    const payload = prompt.includes('"fields"')
      ? { decisions: [{ fieldId: 'unknown', action: 'ask_user', value: null, evidenceKeys: [], confidence: 'low', sensitivity: 'safe', reason: 'No evidence', transformation: null }] }
      : { suggestions: [], missingContext: 'No evidence' };
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }) };
  };
  await import(`../src/service-worker.js?fireworks-default=${Date.now()}`);
  const started = await harness.dispatch({ type: 'JOB_RUN_START', tabId: 7 });
  assert.equal(started.ok, true, started.error);
  assert.equal(requests[0].url, 'https://api.fireworks.ai/inference/v1/chat/completions');
  assert.equal(requests[0].authorization, 'Bearer synthetic-fireworks-key');
  assert.equal(requests[0].body.model, 'accounts/fireworks/models/glm-5p3-flash');
  assert.equal(requests[0].body.messages.length, 2);
  assert.equal(harness.localData.openaiApiKey, '');
});

test('invalid optional fields block; validation-only refresh never fills or calls AI', async () => {
  const h=createHarness({pagesByTab:{7:{pages:[{fields:[{id:'email',handle:'email-h',label:'Email',type:'email',currentValue:'bad'}],invalidFieldIds:['email'],actions:[{id:'next',kind:'next',label:'Next'}]}]}}});
  await import(`../src/service-worker.js?optional-invalid-${Date.now()}`);
  const response=await h.dispatch({type:'JOB_RUN_START',tabId:7});
  assert.ok(response.run.actionRequired.some(field=>field.fieldId==='email'));
  assert.equal(response.run.optionalUnresolved.length,0);
  const count=h.tabs.get(7).messages.filter(message=>message.type==='JOB_APP_APPLY').length;
  assert.equal((await h.dispatch({type:'JOB_RUN_VALIDATE_PAGE',tabId:7})).ok,true);
  assert.equal(h.tabs.get(7).messages.filter(message=>message.type==='JOB_APP_APPLY').length,count);
  assert.equal(h.tabs.get(7).nextClicks,0);
});

test('local results return before AI and optional questions do not generate automatically', async () => {
  const h=createHarness({waitForAI:false,pagesByTab:{7:{pages:[{page:{title:'Application',domain:'example.test'},fields:[{id:'required',handle:'r-h',label:'Why this role?',type:'textarea',required:true},{id:'optional',handle:'o-h',label:'Additional information',type:'textarea'}],actions:[]}]}}});
  h.localData.openaiApiKey='test-key'; let release;const requests=[];
  globalThis.fetch=async(_url,options)=>{const body=JSON.parse(options.body);const request=JSON.parse(body.input[1].content[0].text);requests.push(request);if(request.fields)await new Promise(resolve=>{release=resolve;});return{ok:true,json:async()=>({output_text:JSON.stringify(request.fields?{decisions:[]}:{suggestions:[],missingContext:'Add relevant experience'})})};};
  await import(`../src/service-worker.js?background-${Date.now()}`);
  const response=await Promise.race([h.dispatch({type:'JOB_RUN_START',tabId:7}),new Promise(resolve=>setTimeout(()=>resolve({error:'Blocked on AI'}),600))]);
  try{assert.equal(response.ok,true,response.error);assert.notEqual(response.run.waitingFor,'extension_error');assert.ok(release,'planner actually started');}finally{release?.();}
  for(let n=0;n<100&&Object.values(h.sessionData.applicationRun['7'].aiOperations||{}).some(op=>op.status==='pending');n++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(requests.filter(request=>request.field?.id==='optional').length,0);
});

test('worker restart marks pending operations interrupted without replaying navigation', async () => {
  const h=createHarness({pagesByTab:{7:{pages:[{fields:[],actions:[]}]}}});
  h.sessionData.applicationRun={'7':{tabId:7,startedAt:'old-run',status:'running',revision:3,aiOperations:{planner:{status:'pending'}},frame:{frameId:0},actionRequired:[],reviewRequired:[],optionalUnresolved:[]}};
  await import(`../src/service-worker.js?restart-${Date.now()}`);
  const response=await h.dispatch({type:'JOB_RUN_STATE',tabId:7});
  assert.equal(response.run.aiOperations.planner.status,'interrupted');assert.equal(response.run.status,'waiting_user');assert.equal(h.tabs.get(7).nextClicks,0);
});
