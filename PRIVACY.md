# Privacy notes

This personal unpacked extension fills job-application forms from an answer profile stored in Chrome extension storage.

- `answerRecords` and the OpenAI API key are stored in `chrome.storage.local`.
- The API key is read only by trusted extension contexts and is never sent to a web page.
- The active page is inspected only after you click **Fill application**, **Continue**, or **Confirm & submit**.
- The model receives only the page title/hostname, visible field descriptors, and learned answer records needed for unresolved fields.
- Raw HTML, hidden inputs, passwords, cookies, query-string URLs, and file contents are excluded from model requests.
- OpenAI requests use `store: false`. Failed requests do not prevent local deterministic filling; the run pauses for manual completion.
- Answers are saved for future use only after your explicit final submission confirmation.
- Safe records can be reused automatically. Review and legal records are prefilled but remain visible for final review.
- Passwords and file inputs are never filled. Resume upload, CAPTCHA, login, cross-origin frames, shadow roots, and custom widgets remain manual.
- There is no backend, telemetry, analytics, Google integration, CSV importer, or background page monitoring.

Removing the extension removes its local Chrome storage. Review the OpenAI account and API-key policies that apply to your use before entering a key.

Do not publish this extension without completing Chrome Web Store privacy disclosures and reviewing current program policies.
