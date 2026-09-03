# Privacy notes

This personal unpacked extension has one purpose: fill job-application fields from answers selected by its user.

- Google Sheet data is read with `spreadsheets.readonly` after an explicit **Sync Google Sheet** action.
- Normalized answers are cached in `chrome.storage.local`.
- Extension storage is restricted to trusted extension contexts when supported by Chrome.
- The extension has host access to all URLs so it can support arbitrary job boards and ATS providers. It does not inspect pages until the user triggers **Scan form**, **Fill safe fields**, or learning for the active tab.
- No analytics, advertising, telemetry, remote AI calls, password collection, or form submission is implemented.
- Password and file inputs are ignored.
- Removing the extension removes its local Chrome storage. Google access can also be revoked from the Google Account permissions page.

Do not publish this extension without completing Chrome Web Store privacy disclosures and reviewing data handling against current program policies.
