import {
  applyDecisions,
  clickAction,
  collectAnswerRecords,
  inspectDocument,
  validateDocument,
  focusField,
  submitDocument,
} from './form-engine.js';

function notifyNavigation() {
  let sent = false;
  let observer;
  const send = () => {
    if (sent) return;
    sent = true;
    observer?.disconnect();
    chrome.runtime.sendMessage({ type: 'JOB_APP_NAVIGATED' }).catch(() => {});
  };
  if (typeof MutationObserver === 'function' && document.documentElement) {
    observer = new MutationObserver(send);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  }
  setTimeout(send, 500);
}

if (!globalThis.__jobApplicationAutofillInstalled) {
  globalThis.__jobApplicationAutofillInstalled = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      switch (message?.type) {
        case 'JOB_APP_PING':
          sendResponse({ ok: true });
          break;
        case 'JOB_APP_INSPECT':
          sendResponse({ ok: true, inspection: inspectDocument(document) });
          break;
        case 'JOB_APP_APPLY':
          sendResponse({ ok: true, result: applyDecisions(document, message.decisions || []) });
          break;
        case 'JOB_APP_CAPTURE':
          sendResponse({ ok: true, records: collectAnswerRecords(document) });
          break;
        case 'JOB_APP_VALIDATE':
          sendResponse({ ok: true, validation: validateDocument(document) });
          break;
        case 'JOB_APP_FOCUS':
          sendResponse({ ok: focusField(document, message.fieldId) });
          break;
        case 'JOB_APP_CLICK_NEXT':
          {
            const result = clickAction(document, message.actionId);
            if (result.ok) notifyNavigation();
            sendResponse(result);
          }
          break;
        case 'JOB_APP_SUBMIT':
          sendResponse(submitDocument(document));
          break;
        default:
          return false;
      }
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return false;
  });
}
