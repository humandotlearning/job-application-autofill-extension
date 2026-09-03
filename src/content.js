import { collectChangedResponses, scanAndFillDocument, snapshotFormValues } from './form-engine.js';

let learningSession = null;

function stopLearning() {
  if (!learningSession) return;
  for (const [eventName, listener] of learningSession.listeners) {
    document.removeEventListener(eventName, listener, true);
  }
  learningSession = null;
}

function startLearning() {
  stopLearning();
  const initialValues = snapshotFormValues(document);
  const listeners = [];
  const capture = () => {
    const records = collectChangedResponses(document, initialValues);
    if (records.length) chrome.runtime.sendMessage({ type: 'JOB_AUTOFILL_LEARNED', records }).catch(() => {});
  };
  for (const eventName of ['input', 'change', 'blur']) {
    document.addEventListener(eventName, capture, true);
    listeners.push([eventName, capture]);
  }
  learningSession = { initialValues, listeners };
  return { ok: true, observed: snapshotFormValues(document).size };
}

if (!globalThis.__jobApplicationAutofillInstalled) {
  globalThis.__jobApplicationAutofillInstalled = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'JOB_AUTOFILL_PING') {
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'JOB_AUTOFILL_START_LEARNING') {
      try {
        sendResponse(startLearning());
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return false;
    }
    if (message?.type === 'JOB_AUTOFILL_STOP_LEARNING') {
      stopLearning();
      sendResponse({ ok: true });
      return false;
    }
    if (!['JOB_AUTOFILL_SCAN', 'JOB_AUTOFILL_FILL'].includes(message?.type)) return false;

    try {
      const report = scanAndFillDocument(document, message.records || [], {
        fill: message.type === 'JOB_AUTOFILL_FILL',
        overwrite: Boolean(message.overwrite),
        includeEmailTemplates: Boolean(message.includeEmailTemplates),
      });
      report.page = { title: document.title, url: location.href };
      sendResponse({ ok: true, report });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return false;
  });
}
