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
  applicationDestination,
  selectApplicationRegion,
  selectApplicationField,
  clearApplicationSelection,
} from './form-engine.js';
import { eventControl } from './dom.js';
import { createLearningSession } from './learning.js';
import { createInlineAutofill } from './inline-autofill.js';

let runtimeDisconnected = false;
async function sendRuntimeMessage(message) {
  if (runtimeDisconnected) throw new Error('Extension context invalidated.');
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (/Extension context invalidated/i.test(error.message)) runtimeDisconnected = true;
    throw error;
  }
}

function notifyNavigation() {
  waitForDocumentSettled(document).then(() => sendRuntimeMessage({ type: 'JOB_APP_NAVIGATED' })).catch(() => {});
}

const CONTENT_VERSION = 'autofill-ux-6';
if (!globalThis.__jobApplicationAutofillInstalled) {
  globalThis.__jobApplicationAutofillInstalled = CONTENT_VERSION;
  let inline = null;
  let learning = null;
  let active = false;
  let resolveReady;
  let ready = false;
  let forcedState = null;
  let selectionRequest = null;
  let selectionTimer = null;
  const readyPromise = new Promise(resolve => { resolveReady = resolve; });

  function cancelSelection() {
    selectionRequest = null;
    clearTimeout(selectionTimer);
  }

  function invalidateDestination() {
    cancelSelection();
    clearApplicationSelection(document);
  }
  document.defaultView.addEventListener('pagehide', invalidateDestination);
  document.defaultView.addEventListener('popstate', invalidateDestination);
  document.defaultView.addEventListener('hashchange', invalidateDestination);
  document.addEventListener('click', event => {
    const request = selectionRequest;
    if (!active || !request || !event.isTrusted || Date.now() > request.expiresAt) return;
    const control = eventControl(event);
    const destination = selectApplicationRegion(document, control);
    if (!destination?.regionId && !selectApplicationField(document, control)) return;
    cancelSelection();
    sendRuntimeMessage({type: 'JOB_APP_FORM_SELECTED', token: request.token,
      destination: destination || applicationDestination(document), fieldOnly: !destination?.regionId}).catch(() => {});
  }, true);

  function destinationMatches(expected) {
    if (!expected) return true;
    const current = applicationDestination(document);
    return expected.documentId === current.documentId && expected.regionId === current.regionId;
  }

  async function inspectWhenReady() {
    const start = Date.now();
    let settled;
    let inspection;
    do {
      settled = await waitForDocumentSettled(document, {minWaitMs: 150, quietMs: 75, timeoutMs: Math.max(1, 2500 - (Date.now() - start))});
      inspection = inspectDocument(document);
      if (inspection.fields.length || inspection.discovery?.code === 'ambiguous_form' || settled?.timedOut || Date.now() - start >= 2350) break;
    } while (Date.now() - start < 2500);
    if (settled?.timedOut && !inspection.fields.length && inspection.discovery) inspection.discovery.code = 'loading_timeout';
    return inspection;
  }

  function disable() {
    invalidateDestination();
    if (inline) inline.dispose();
    if (learning) learning.dispose();
    inline = null;
    learning = null;
    active = false;
  }

  function enable() {
    if (active) return;
    active = true;
    inline = createInlineAutofill(document, {send: message => sendRuntimeMessage(message), describe: descriptorForElement});
    learning = createLearningSession(document, {
      capture: (options) => collectAnswerRecords(document, options),
      send: (message) => sendRuntimeMessage(message),
      onRevalidate: ({applicationId}) => sendRuntimeMessage({type:'JOB_APP_REVALIDATE',applicationId}),
      onFinalSubmit: ({ applicationId, records, event }) => {
        if (!isFinalApplicationSubmit(document, event)) return null;
        return sendRuntimeMessage({
          type: 'JOB_APP_FINAL_SUBMISSION',
          applicationId,
          page: inspectDocument(document).page,
          records,
        });
      },
    });
    inline.refresh();
    sendRuntimeMessage({ type: 'JOB_APP_LEARNING_STATUS' }).then((response) => {
      if (active && response?.applicationId) learning.activate(response.applicationId);
    }).catch(() => {});
  }

  function handleMessage(message, _sender, sendResponse) {
    try {
      if (message?.destination && !destinationMatches(message.destination)) {
        sendResponse({ok: false, code: 'destination_changed', error: 'The selected form changed. Retry the scan.'});
        return false;
      }
      switch (message?.type) {
        case 'JOB_APP_SELECT_FORM':
          if (!active) { sendResponse({ok: false, disabled: true}); break; }
          cancelSelection();
          selectionRequest = {token: message.token, expiresAt: Math.min(message.expiresAt, Date.now() + 60_000)};
          selectionTimer = setTimeout(cancelSelection, Math.max(0, selectionRequest.expiresAt - Date.now()));
          sendResponse({ok: true, destination: applicationDestination(document)});
          break;
        case 'JOB_APP_CANCEL_FORM_SELECTION':
          cancelSelection();
          sendResponse({ok: true});
          break;
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
          inspectWhenReady().then(inspection => sendResponse({ ok: true, inspection, version: CONTENT_VERSION }))
            .catch((error) => sendResponse({ ok: false, code: 'inspection_error', error: error.message }));
          return true;
        case 'JOB_APP_INSPECT_INLINE': {
          if (!active) { sendResponse({ok: false, disabled: true}); break; }
          const inspection = inspectDocument(document);
          inspection.page.url = document.location.href;
          const focused = descriptorForElement(document, inline.activeField());
          if (focused && !inspection.fields.some(field => field.handle === focused.handle)) inspection.fields.push(focused);
          sendResponse({ok: true, inspection, focusedFieldId: focused?.id ?? null, focusedHandle: focused?.handle ?? null,
            rawValue: focused?.rawValue ?? null, editRevision: focused?.editRevision ?? null});
          break;
        }
        case 'JOB_APP_APPLY': {
          if (!active) { sendResponse({ok: false, disabled: true, result: {applied: [], kept: [], reviewRequired: [], unresolved: [], failed: []}}); break; }
          const destination = message.destination || applicationDestination(document);
          if (!destination.regionId) {
            const focused = descriptorForElement(document, inline.activeField());
            const decisions = message.decisions || [];
            if (decisions.length !== 1 || !focused || !decisions[0].approved || decisions[0].handle !== focused.handle) {
              sendResponse({ok: false, code: 'destination_changed', error: 'Select a form, or use suggestions for the focused field.'});
              break;
            }
            selectApplicationField(document, inline.activeField());
          }
          if (message.applicationId) learning.activate(message.applicationId);
          applyDecisions(document, message.decisions || [], {deadline: message.deadline ?? Infinity,
            beforeFill: args => active && destinationMatches(destination) && inline.beforeFill({...args, acceptanceToken: message.approvalGuard?.acceptanceToken})})
            .then((result) => sendResponse({ ok: true, result }))
            .catch((error) => sendResponse({ ok: false, error: error.message }));
          return true;
        }
        case 'JOB_APP_CAPTURE':
          if (!active) { sendResponse({ok: false, disabled: true, records: []}); break; }
          sendResponse({ ok: true, records: collectAnswerRecords(document, { finalize: message.finalize === true }) });
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
            if (!destinationMatches(message.destination)) { sendResponse({ok: false, code: 'destination_changed'}); return; }
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

  sendRuntimeMessage({ type: 'JOB_APP_SITE_STATUS' }).then((response) => {
    const enabled = forcedState == null
      ? response?.enabled === true
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
