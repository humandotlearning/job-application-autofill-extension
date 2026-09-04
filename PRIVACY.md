# Privacy notes

This personal unpacked extension fills job-application forms from an answer profile stored in Chrome extension storage.

- `answerRecords`, cover-message templates, datasource metadata, and the OpenAI API key are stored in `chrome.storage.local`.
- The bundled `data/seed-data.json` is imported only into an empty local datasource; extension updates do not overwrite accumulated answers.
- Datasource backups contain answers and templates but never include the OpenAI API key.
- The API key is read only by trusted extension contexts and is never sent to a web page.
- The active page is inspected only after you click **Fill this page**, **Check again**, **Continue to next page**, or **Save answers**.
- Embedded frames are enumerated and inspected locally only during those actions; frame selection metadata is not sent to the model.
- If no unique application frame is identified, the extension pauses without applying values to any frame.
- The model receives only the page title/hostname, visible field descriptors, and learned answer records needed for unresolved fields.
- Raw HTML, hidden inputs, passwords, cookies, query-string URLs, and file contents are excluded from model requests.
- OpenAI requests use `store: false`. Failed requests do not prevent local deterministic filling; the run pauses for manual completion.
- Answers are saved for future use only after your explicit final **Save answers** action.
- Safe records can be reused automatically. Review and legal records are prefilled but remain visible for final review.
- Passwords and file inputs are never filled. Resume upload, CAPTCHA, login, inaccessible shadow roots, and ambiguous custom widgets remain manual.
- The extension never clicks a site Submit control; after saving, you review and submit through the application site yourself.
- There is no backend, telemetry, analytics, Google integration, runtime workbook importer, or background page monitoring.

Removing the extension removes its local Chrome storage. Review the OpenAI account and API-key policies that apply to your use before entering a key.

Do not publish this extension without completing Chrome Web Store privacy disclosures and reviewing current program policies.
