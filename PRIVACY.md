# Privacy notes

This personal unpacked extension fills job-application forms from an answer profile stored in Chrome extension storage.

- `answerRecords`, application drafts, correction history, cover-message templates, datasource metadata, provider selection, model selection, and provider-specific API keys are stored in `chrome.storage.local`.
- The bundled `data/seed-data.json` is imported only into an empty local datasource; extension updates do not overwrite accumulated answers. Legacy pending answers are migrated before obsolete keys are removed.
- Datasource backups contain answers and templates but never include any API key.
- The API key is read only by trusted extension contexts and is never sent to a web page.
- Clicking **Fill this page** activates inspection and learning for the selected application frame. During that application, edits, checkpoints, and navigation can trigger local inspection and draft persistence.
- Embedded frames are inspected locally during explicit actions and to restore an activated application after navigation; frame routing metadata is not sent to the model.
- If no unique application frame is identified, the extension pauses without applying values to any frame.
- The model receives only the page title/hostname, visible field descriptors, and learned answer records needed for unresolved fields.
- Raw HTML, hidden inputs, passwords, cookies, query-string URLs, and file contents are excluded from model requests.
- OpenAI requests use `store: false`; Fireworks requests use its OpenAI-compatible Chat Completions endpoint. Failed requests do not prevent local deterministic filling; the run pauses for manual completion.
- Completed, valid new answers are learned automatically during an activated application. Sensitive answers and conflicting changes require confirmation in the side panel. Extension-generated values remain provisional; captured drafts retain their provenance across reloads. **Save answers** remains a checkpoint.
- Safe records can be reused automatically. Review and legal records are prefilled but remain visible for final review.
- Passwords and file inputs are never filled. Resume upload, CAPTCHA, login, inaccessible shadow roots, and ambiguous custom widgets remain manual.
- The extension never clicks or blocks a site Submit control. When you submit the detected final application form yourself, it captures the current values locally without delaying the site submission.
- There is no backend, telemetry, analytics, Google integration, or runtime workbook importer. Edit monitoring is limited to activated application frames.

Removing the extension removes its local Chrome storage. Review the provider account and API-key policies that apply to your use before entering a key.

Do not publish this extension without completing Chrome Web Store privacy disclosures and reviewing current program policies.
