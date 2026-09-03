import { scanAndFillDocument } from './form-engine.js';

if (!globalThis.__jobApplicationAutofillInstalled) {
  globalThis.__jobApplicationAutofillInstalled = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'JOB_AUTOFILL_PING') {
      sendResponse({ ok: true });
      return false;
    }
    if (!['JOB_AUTOFILL_SCAN', 'JOB_AUTOFILL_FILL'].includes(message?.type)) return false;

    try {
      const report = scanAndFillDocument(document, message.records || [], {
        fill: message.type === 'JOB_AUTOFILL_FILL',
        overwrite: Boolean(message.overwrite),
      });
      report.page = { title: document.title, url: location.href };
      sendResponse({ ok: true, report });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return false;
  });
}
