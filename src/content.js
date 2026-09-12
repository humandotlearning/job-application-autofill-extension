import {
  applyDecisions,
  clickAction,
  collectAnswerRecords,
  inspectDocument,
  descriptorForElement,
  validateDocument,
  focusField,
  isFinalApplicationSubmit,
  waitForDocumentSettled,
} from './form-engine.js';
import { createLearningSession } from './learning.js';
import { createInlineAutofill } from './inline-autofill.js';

function notifyNavigation() {
  waitForDocumentSettled(document).then(() => chrome.runtime.sendMessage({ type: 'JOB_APP_NAVIGATED' })).catch(() => {});
}

const CONTENT_VERSION = 'reliable-review-1';
if (!globalThis.__jobApplicationAutofillInstalled) {
  globalThis.__jobApplicationAutofillInstalled = CONTENT_VERSION;
  let inline = null;
  let learning = null;
  let active = false;
  let resolveReady;
  let ready = false;
  let forcedState = null;
  const readyPromise = new Promise(resolve => { resolveReady = resolve; });

  function disable() {
    if (inline) inline.dispose();
    if (learning) learning.dispose();
    inline = null;
    learning = null;
    active = false;
  }

  function enable() {
    if (active) return;
    active = true;
    inline = createInlineAutofill(document, {send: message => chrome.runtime.sendMessage(message), describe: descriptorForElement});
    learning = createLearningSession(document, {
      capture: () => collectAnswerRecords(document),
      send: (message) => chrome.runtime.sendMessage(message),
      onRevalidate: ({applicationId}) => chrome.runtime.sendMessage({type:'JOB_APP_REVALIDATE',applicationId}),
      onFinalSubmit: ({ applicationId, records, event }) => {
        if (!isFinalApplicationSubmit(document, event)) return null;
        return chrome.runtime.sendMessage({
          type: 'JOB_APP_FINAL_SUBMISSION',
          applicationId,
          page: inspectDocument(document).page,
          records,
        });
      },
    });
    inline.refresh();
    chrome.runtime.sendMessage({ type: 'JOB_APP_LEARNING_STATUS' }).then((response) => {
      if (active && response?.applicationId) learning.activate(response.applicationId);
    }).catch(() => {});
  }

  function handleMessage(message, _sender, sendResponse) {
    try {
      switch (message?.type) {
        case 'JOB_APP_SITE_STATE_CHANGED':
          forcedState = Boolean(message.enabled);
          if (message.enabled) enable(); else disable();
          sendResponse({ok: true, enabled: active});
          break;
        case 'JOB_APP_PING':
          sendResponse({ ok: true, version: CONTENT_VERSION });
          break;
        case 'JOB_APP_INSPECT':
          if (!active) { sendResponse({ok: false, disabled: true}); break; }
          waitForDocumentSettled(document, { minWaitMs: 150, quietMs: 75 }).then(() => sendResponse({ ok: true, inspection: inspectDocument(document) }))
            .catch((error) => sendResponse({ ok: false, error: error.message }));
          return true;
        case 'JOB_APP_INSPECT_INLINE': {
          if (!active) { sendResponse({ok: false, disabled: true}); break; }
          const inspection = inspectDocument(document);
          inspection.page.url = document.location.href;
          const focused = descriptorForElement(document, inline.activeField());
          sendResponse({ok: true, inspection, focusedFieldId: focused?.id ?? null, focusedHandle: focused?.handle ?? null,
            rawValue: focused?.rawValue ?? null, editRevision: focused?.editRevision ?? null});
          break;
        }
        case 'JOB_APP_APPLY':
          if (!active) { sendResponse({ok: false, disabled: true, result: {applied: [], kept: [], reviewRequired: [], unresolved: [], failed: []}}); break; }
          if (message.applicationId) learning.activate(message.applicationId);
          applyDecisions(document, message.decisions || [], {deadline: message.deadline ?? Infinity,
            beforeFill: args => inline.beforeFill({...args, acceptanceToken: message.approvalGuard?.acceptanceToken})})
            .then((result) => sendResponse({ ok: true, result }))
            .catch((error) => sendResponse({ ok: false, error: error.message }));
          return true;
        case 'JOB_APP_CAPTURE':
          if (!active) { sendResponse({ok: false, disabled: true, records: []}); break; }
          sendResponse({ ok: true, records: collectAnswerRecords(document) });
          break;
        case 'JOB_APP_VALIDATE':
          if (!active) { sendResponse({ok: false, disabled: true, validation: {ok: false, requiredEmpty: [], invalid: []}}); break; }
          sendResponse({ ok: true, validation: validateDocument(document) });
          break;
        case 'JOB_APP_FOCUS':
          if (!active) { sendResponse({ok: false, disabled: true}); break; }
          sendResponse({ ok: inline.withExplicitFocus(() => focusField(document, message.fieldId, message.handle)) });
          break;
        case 'JOB_APP_CLICK_NEXT':
          if (!active) { sendResponse({ok: false, disabled: true}); break; }
          learning.flush().then(() => {
            const result = clickAction(document, message.actionId);
            if (result.ok) notifyNavigation();
            sendResponse(result);
          }).catch((error) => sendResponse({ ok: false, error: error.message }));
          return true;
        default:
          return false;
      }
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return false;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!ready && message?.type !== 'JOB_APP_PING' && message?.type !== 'JOB_APP_SITE_STATE_CHANGED') {
      readyPromise.then(() => handleMessage(message, sender, sendResponse));
      return true;
    }
    return handleMessage(message, sender, sendResponse);
  });

  chrome.runtime.sendMessage({ type: 'JOB_APP_SITE_STATUS' }).then((response) => {
    const enabled = forcedState == null
      ? response?.enabled !== false && response?.supported !== false
      : forcedState;
    if (!enabled) disable();
    else enable();
    ready = true;
    resolveReady();
  }).catch(() => {
    disable();
    ready = true;
    resolveReady();
  });
}
