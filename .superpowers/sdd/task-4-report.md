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
