import {
  applyDecisions,
  clickAction,
  collectAnswerRecords,
  inspectDocument,
  validateDocument,
  focusField,
  submitDocument,
} from './form-engine.js';

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
          sendResponse(clickAction(document, message.actionId));
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
