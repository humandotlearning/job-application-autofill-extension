# Job Application Autofill Chrome Extension

A Manifest V3 side-panel extension that scans the current job application and fills all **verified, safe** answers in one pass. It uses the provided Google Sheet as its default source and keeps the normalized answer cache in Chrome local storage.

## Current data source

The extension is preconfigured with:

```text
https://docs.google.com/spreadsheets/d/1SoKWd8RL1YpZxP3Bvs5bclF_fhs47VZpk1wh6H6UBJ0/edit?gid=0#gid=0
```

The workbook is private: an unauthenticated export currently returns HTTP 401. The extension therefore supports Google OAuth with the read-only Sheets scope. It reads every tab and combines reusable records.

The observed workbook layouts are supported:

- `Sheet1`: headerless key/value rows such as `LinkedIn:` and its URL.
- `common questions`: `Questions` and `Answers` headers.
- `email`: unstructured email text; ignored by the form-answer importer.

It also accepts a local CSV as a fallback. You do **not** need to publish the sheet or enable “Anyone with the link.”

## What the MVP does

- Opens in Chrome's side panel and works in the actual visible tab.
- Reads all tabs from the configured Google Sheet.
- Supports `Field/Value`, `Question/Answer`, `Questions/Answers`, and headerless two-column key/value layouts.
- Finds labels through native labels, ARIA metadata, placeholders, field names, legends, and autocomplete metadata.
- Bulk-fills text inputs, textareas, selects, checkboxes, and radio groups.
- Dispatches `input`, `change`, and `blur` events for React-style forms.
- Preserves fields that already contain a value unless **Replace fields** is enabled.
- Reports filled, existing, review-gated, unknown, failed, and required-empty fields.
- Can start an explicit learning observer after autofill and capture later field changes locally as pending answers.
- Lets you approve safe learned answers for future autofill; sensitive learned answers remain review-gated.
- Never touches passwords, file uploads, buttons, or submit controls.
- Defaults salary/CTC, authorization, sponsorship, citizenship, notice-period, reference, and relocation questions to review when the sheet has no policy column.
- Defaults consent, agreement, attestation, privacy, demographic, disability, veteran, criminal, and conflict questions to legal review.

## One-time installation

The project is already built. To load it:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose:

   ```text
   C:\Users\nithi\job-application-autofill-extension
   ```

5. Pin **Job Application Autofill** if desired.
6. Copy the extension ID shown on the extension card; it is needed for private Google Sheet access.

Loading an unpacked extension is a Chrome permission action, so it is intentionally left for you to approve in Chrome.

## Enable private Google Sheet synchronization

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project.
3. Open **APIs & Services → Library** and enable **Google Sheets API**.
4. Configure the OAuth consent screen. If the app is in testing, add your Google account as a test user.
5. Open **APIs & Services → Credentials → Create credentials → OAuth client ID**.
6. Select **Chrome Extension** as the application type.
7. Paste the extension ID from `chrome://extensions` into **Item ID**.
8. Copy the generated client ID.
9. In `manifest.json`, replace:

   ```text
   REPLACE_WITH_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com
   ```

   with the generated client ID.
10. Return to `chrome://extensions` and click **Reload** on the extension card.
11. Open the extension side panel and select **Sync Google Sheet**.
12. Approve the read-only Google Sheets permission.

The extension requests only:

```text
https://www.googleapis.com/auth/spreadsheets.readonly
```

Reference: [Chrome OAuth guide](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth).

## Recommended Google Sheet columns

Existing two-column tabs continue to work. For stronger matching and explicit safety, use this optional schema:

| Column | Purpose | Example |
|---|---|---|
| `Key` | Stable canonical identifier | `linkedin` |
| `Question` | Main form label | `LinkedIn URL` |
| `Answer` | Reusable value | `https://linkedin.com/in/...` |
| `Aliases` | Semicolon-separated alternate labels | `LinkedIn;LinkedIn profile` |
| `Type` | Informational field type | `url` |
| `Status` | `verified` or `draft` | `verified` |
| `Sensitivity` | `safe`, `review`, or `legal` | `safe` |
| `Options` | Optional semicolon-separated choices | `Yes;No` |

Only records with `Status=verified` and `Sensitivity=safe` are automatically filled. A blank status defaults to `verified`; a blank sensitivity is inferred conservatively from the question.

## Daily use

1. Open a job application.
2. Use the employer's **Autofill with Resume** or **Parse Resume** feature first when available.
3. Open **Job Application Autofill** from the Chrome toolbar.
4. Select **Sync Google Sheet** after changing the workbook.
5. Select **Scan form** to preview matches without changing the page.
6. Select **Fill safe fields** to populate all verified safe matches in one pass.
7. Review the side-panel report and the visible form.
8. Select **Start learning** after the first autofill, complete missing answers, and leave the page open while you work.
9. Review the pending learned-answer count in the side panel. Select **Approve safe learned answers** only after checking them; salary, legal, consent, demographic, authorization, and similar responses stay pending.
10. Handle resume upload, login, CAPTCHA, consent, and unknown questions manually or through the Hermes workflow.
11. Submit only after explicit review.

## Local CSV fallback

Select **Import CSV** in the side panel and choose a CSV using one of the supported layouts. A starting template is available at `examples/answers-template.csv`.

## Development

PowerShell:

```powershell
Set-Location C:\Users\nithi\job-application-autofill-extension
npm install
npm run build
npm test
npm run check
```

`npm run build` combines the tested ES modules into `dist/content.js`, a classic script that Chrome can inject into job pages.

## Test page

Serve the project over HTTP, because Chrome does not grant `file://` access by default:

```powershell
Set-Location C:\Users\nithi\job-application-autofill-extension
python -m http.server 8765
```

Then open `http://127.0.0.1:8765/examples/demo-form.html`, import `examples/answers-template.csv`, scan, and fill.

## Known MVP limitations

- Does not upload a resume; Chrome's native file picker remains a user/computer-use operation.
- Does not automatically click ATS resume-import buttons, Next, Continue, or Submit.
- Does not yet integrate Hermes answer drafting into the side panel.
- Does not yet handle controls inside cross-origin iframes or shadow roots.
- Highly customized comboboxes may be reported as failed and need an ATS adapter.
- A Microsoft Excel `.xlsx` stored in Drive is not parsed directly. Convert it to a Google Sheet or download it as CSV. The supplied source is already a Google Sheet.

## Privacy

See [PRIVACY.md](PRIVACY.md). Personal answers stay in Chrome local storage and are sent only to the active page when you explicitly scan or fill. The extension does not include analytics or remote AI calls.
