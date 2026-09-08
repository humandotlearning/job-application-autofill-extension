# Task 5: Planner answers require explicit review

## Completed

- Planner `fill` decisions now become pending candidates in `run.suggestions`; they never reach `JOB_APP_APPLY` during page processing.
- Each planner candidate retains its answer, every `sourceKey`, immutable source-answer snapshots, transformation, reason, confidence, sensitivity, and `AI planner` provenance.
- Explicit approval accepts legacy singular keys and plural source keys. It rechecks every source key, answer snapshot, and field relevance before applying a candidate.
- Approved planner fills carry all evidence keys, and reusable learning keeps all of those keys. Suggestions are removed only after the page retains the approved value.

## Verification

- `npm test -- tests/service-worker.test.js` — 36 passing.
- `npm test` — 221 passing.
- `npm run check` — passing.
- `npm run build` — passing; rebuilt `dist/content.js` is intentionally not part of this task's selective commit.

## Notes

- The new worker tests cover pending planner proposals, explicit approval, plural evidence snapshots, and rejection when any source changes.
- Existing local, draft, and equivalent single-source approvals remain covered by the worker suite through the legacy singular-key fallback.

## Follow-up review fixes

- Pending suggestions now survive `Check again` while the page/frame signature is unchanged. They clear only when that origin changes or after verified approval.
- Multi-source planner coverage now verifies retained transformation metadata, all evidence keys in the approved fill, and all evidence keys on the learned record.
- Follow-up verification: worker suite 36/36 and full suite 221/221 passing.
