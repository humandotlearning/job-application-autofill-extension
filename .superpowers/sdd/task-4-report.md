# Task 4 report — guarded draft apply and rewrite

## Completed

- Added panel-only `JOB_RUN_APPLY_DRAFT` and `JOB_RUN_REWRITE_ANSWER` worker routes.
- Manual drafts are bounded, opaque-ID blocked, re-inspected in the selected frame, value-validated, retained-checked after fill, and never promoted to saved answer records.
- Rewrite requests validate the same run/page/frame/handle origin, use only selected current evidence, read the configured model and API key in the worker, and return a bounded replacement answer without changing the page, run, or datasource.
- Added worker-compatible run/frame aliases and unresolved-field handle snapshots for manual drafts.

## Coverage

- Exact manual fill with no answer-record or draft-storage promotion.
- Stale tab/frame/application/page/handle and changed field rejection.
- Invalid options/constraints, legal fields, checkboxes, and opaque IDs rejected.
- Panel-only sender guard for both operations.
- Configured model/evidence rewrite request and non-mutating successful response.
- Missing key, stale/empty/non-string/overlong request data, malformed output, and network failure remain non-mutating.

## Verification

`npm test -- tests/service-worker.test.js` — 31 passing, 0 failing.

`npm run check` — passing.

`git diff --check` — passing.

## Concern

The next planner-gating task must extend the existing approval path for multi-source planner candidates. This task intentionally leaves approval semantics unchanged and only resolves selected evidence for rewrite.

## Follow-up safety fix

- Manual draft application now classifies sensitivity with both the live field label and field ID. A generic label can no longer bypass the legal-field block when its ID identifies privacy, consent, attestation, or similar legal input.
- Added a regression case for `privacy_acknowledgement` with the generic label `Response`; it is rejected without page mutation.
- Re-ran `npm test -- tests/service-worker.test.js`: 31 passing, 0 failing.

## Re-review safety fixes

- A nonempty field value can now be replaced only after a fresh exact-frame validation marks that same field invalid. Valid existing values remain blocked.
- Deterministic candidate gating and saved-answer approval now classify sensitivity with both the field label and field ID, preventing generic labels from bypassing legal IDs.
- Added regressions for invalid-value replacement, valid-value blocking, and a generic-label `privacy_acknowledgement` field that must remain gated and cannot be approved.
- Targeted regressions pass: `node --test --test-name-pattern="manual drafts replace|generic-label legal IDs" tests/service-worker.test.js` — 2 passing.
