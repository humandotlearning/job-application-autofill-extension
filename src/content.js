import {
  applyDecisions,
  clickAction,
  collectAnswerRecords,
  inspectDocument,
  validateDocument,
  focusField,
  isFinalApplicationSubmit,
  waitForDocumentSettled,
} from './form-engine.js';
import { createLearningSession } from './learning.js';

function notifyNavigation() {
  waitForDocumentSettled(document).then(() => chrome.runtime.sendMessage({ type: 'JOB_APP_NAVIGATED' })).catch(() => {});
}

const CONTENT_VERSION = 'reliable-review-1';
if (!globalThis.__jobApplicationAutofillInstalled) {
  globalThis.__jobApplicationAutofillInstalled = CONTENT_VERSION;
  const learning = createLearningSession(document, {
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
  chrome.runtime.sendMessage({ type: 'JOB_APP_LEARNING_STATUS' }).then((response) => {
    if (response?.applicationId) learning.activate(response.applicationId);
  }).catch(() => {});
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      switch (message?.type) {
        case 'JOB_APP_PING':
          sendResponse({ ok: true, version: CONTENT_VERSION });
          break;
        case 'JOB_APP_INSPECT':
          waitForDocumentSettled(document, { minWaitMs: 150, quietMs: 75 }).then(() => sendResponse({ ok: true, inspection: inspectDocument(document) }))
            .catch((error) => sendResponse({ ok: false, error: error.message }));
          return true;
        case 'JOB_APP_APPLY':
          if (message.applicationId) learning.activate(message.applicationId);
          applyDecisions(document, message.decisions || [], {deadline: message.deadline ?? Infinity})
            .then((result) => sendResponse({ ok: true, result }))
            .catch((error) => sendResponse({ ok: false, error: error.message }));
          return true;
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
  });
}
