# Privacy notes

This personal unpacked extension fills job-application forms from an answer profile stored in Chrome extension storage.

- `answerRecords`, application drafts, correction history, cover-message templates, datasource metadata, provider selection, model selection, and provider-specific API keys are stored in `chrome.storage.local`.
- The bundled `data/seed-data.json` is imported only into an empty local datasource; extension updates do not overwrite accumulated answers. Legacy pending answers are migrated before obsolete keys are removed.
- Datasource backups contain answers and templates but never include any API key.
- The API key is read only by trusted extension contexts and is never sent to a web page.
- Clicking **Fill this page** activates inspection and learning for the selected application frame. During that application, edits, checkpoints, and navigation can trigger local inspection and draft persistence.
- Embedded frames are inspected locally during explicit actions and to restore an activated application after navigation; frame routing metadata is not sent to the model.
- If no unique application frame is identified, the extension pauses without applying values to any frame.
- The planner receives unresolved field descriptors, title/hostname, and up to 20 selected answer records. Suggestions can receive up to 40 records plus role/company/job-description text; rewriting receives the draft, instruction, job context, and up to 20 records. Learning classification receives up to 10 eligible new user-answer candidates. These inputs may contain personal answer text.
- Raw HTML, hidden/password inputs, cookies, and file contents are not collected for model requests. Page context omits application URL query strings; user-provided answer text can itself contain URLs.
- OpenAI requests use `store: false`; Fireworks requests use its OpenAI-compatible Chat Completions endpoint. Failed requests do not prevent local deterministic filling; the run pauses for manual completion.
- Edits persist as drafts. Save checkpoints and observed final submit events queue eligible new answers for learning-inbox review; approving a proposal creates a reusable record. Saved-evidence approval can separately save an alias or reviewed answer. Generated values remain provisional. Capture of a submit event is not proof of successful submission.
- Only a unique exact/concept match to a confirmed, compatible, safe short answer can be filled automatically after live validation. Sensitive, narrative, fuzzy, `review_only`, and AI-proposed answers require explicit review. Legal declarations and consent remain manual.
- Passwords and file inputs are never filled. Resume upload, CAPTCHA, login, inaccessible shadow roots, and ambiguous custom widgets remain manual.
- The extension never clicks or blocks a site Submit control. When you submit the detected final application form yourself, it captures the current values locally without delaying the site submission.
- There is no backend, telemetry, analytics, Google integration, or runtime workbook importer. Edit monitoring is limited to activated application frames.

Removing the extension removes its local Chrome storage. Review the provider account and API-key policies that apply to your use before entering a key.

Do not publish this extension without completing Chrome Web Store privacy disclosures and reviewing current program policies.
