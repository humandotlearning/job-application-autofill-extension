# Job Application Autofill

A personal Manifest V3 Chrome extension that fills job forms quickly from a local answer profile, asks an OpenAI model only about unresolved fields, and learns from the values you confirm at submission.

## Runtime flow

```mermaid
flowchart TD
    A[Fill application] --> B[Service worker creates applicationRun]
    B --> C[Inspect visible supported fields]
    C --> D[Deterministic local matching]
    D --> E[Fill validated high-confidence answers]
    E --> F{Fields still empty or invalid?}
    F -->|No| G[Rescan and validate page]
    F -->|Yes| H[One Responses API batch]
    H --> I[Strict JSON decisions]
    I --> J[Validate type, options, pattern, length, bounds]
    J --> G
    G --> K{Manual pause?}
    K -->|Required/invalid, upload, CAPTCHA, login, unsupported widget| L[Focus first issue and wait]
    K -->|No| M{One visible Next/Continue?}
    M -->|Yes| N[Capture page values and click Next]
    N --> C
    M -->|No, one Submit| O[Ready to submit]
    O --> P[User clicks Confirm & submit]
    P --> Q[Rescan and browser validation]
    Q --> R[Save every final non-empty answer]
    R --> S[Submit exactly once]
```

The page receives field descriptors and validated decisions, never the API key. The model cannot execute selectors or click controls.

## How fields and answers move

```mermaid
sequenceDiagram
    participant Panel as Side panel
    participant Worker as Service worker
    participant Page as Content script
    participant Profile as chrome.storage.local
    participant Run as chrome.storage.session
    participant OpenAI as OpenAI Responses API

    Panel->>Worker: Fill application
    Worker->>Run: status=running, keyed by tab
    Worker->>Page: inspect visible fields
    Page-->>Worker: descriptors, actions, pause reasons
    Worker->>Profile: read answerRecords
    Worker->>Page: apply deterministic decisions
    Page-->>Worker: applied, kept, failed, reviewRequired
    Worker->>OpenAI: unresolved descriptors + local records only
    OpenAI-->>Worker: strict FillDecision JSON
    Worker->>Page: apply validated decisions
    Worker->>Page: capture final values before navigation
    Worker->>Run: page snapshots, unresolved, review, audit
    Worker->>Page: click one validated Next/Continue
    Panel->>Worker: Confirm & submit
    Worker->>Page: inspect and validate again
    Worker->>Profile: upsert confirmed values and aliases
    Worker->>Page: real form submission once
```

## Local learning

```mermaid
flowchart LR
    A[User or ATS completes fields] --> B[Capture non-empty supported values]
    B --> C[Canonical key from label]
    C --> D[Merge with existing answerRecords]
    D --> E[Keep aliases and newest answer]
    E --> F[(chrome.storage.local)]
    F --> G[Reuse safe answers automatically]
    F --> H[Prefill review/legal answers and show them at final review]
```

Learning has no separate mode or queue. Saving happens only after the explicit final confirmation. Existing `answerRecords` are normalized during migration; obsolete source configuration and pending queues are discarded.

## Data sent to the model

At most one request is made per page, and only when local answers do not cover it. The request contains:

- page title and hostname;
- visible field descriptors: label, type, autocomplete, current value, options, required state, and HTML constraints;
- local learned answer records: canonical key, question, answer, aliases, type, and sensitivity.

It does not contain raw HTML, hidden inputs, passwords, cookies, URLs with query strings, or the API key. The model must use evidence from the supplied records and return `ask_user` when evidence is missing or ambiguous. Failed API calls fall back to local fills and a manual pause.

The extension uses `gpt-5.6-terra` with low reasoning effort, `store: false`, and strict JSON Schema output. The API key is held in trusted `chrome.storage.local` and read only by the extension side panel/service worker.

## Install and use

1. Run `npm install`, then `npm run build`.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select `C:\Users\nithi\job-application-autofill-extension`.
4. Open a job application and open the extension side panel.
5. Enter an OpenAI API key if you want unresolved-field assistance. Local deterministic filling works without it.
6. Click **Fill application**. Complete any highlighted required fields or manual steps, then click **Continue**.
7. Review the attention list and visible form. Click **Confirm & submit** once the final page is ready.

The first confirmed application seeds the local profile. Later semantically equivalent forms reuse those answers. Safe answers can fill without review; medium-confidence, long-form, review, and legal answers remain visible in final review.

## Boundaries

- Resume uploads, CAPTCHA, login, cross-origin iframes, shadow-root controls, and ambiguous custom widgets remain manual pause points.
- Automation is limited to the active tab and stops after 20 pages.
- Final submission always requires one explicit user confirmation.
- This personal unpacked extension uses a direct API key. A public distribution should move model calls behind a backend.

## Development

```powershell
Set-Location C:\Users\nithi\job-application-autofill-extension
npm install
npm run build
npm test
npm run check
```

The build combines the tested core, form engine, and content bridge into `dist/content.js`, a classic script suitable for runtime injection.

## Demo form

Serve the repository over HTTP:

```powershell
Set-Location C:\Users\nithi\job-application-autofill-extension
python -m http.server 8765
```

Then open [http://127.0.0.1:8765/examples/demo-form.html](http://127.0.0.1:8765/examples/demo-form.html). The two-step demo covers text, select, radio, long-form, required fields, a file-upload pause, Next navigation, submission, and second-run learning.

See [PRIVACY.md](PRIVACY.md) for storage and model-data handling.
