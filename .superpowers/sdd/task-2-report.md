# Task 2 Report: Editable Answer Workspaces

## Files changed

- `src/sidepanel.js`
- `src/sidepanel.css`

## Behavior delivered

- Named action-required and optional fields now have a transient, question-labelled answer workspace.
- Candidate answers remain blank until the applicant chooses one. Choosing copies the answer and its source metadata into in-memory draft state only.
- The applicant can edit a selected answer, use a text instruction to request a rewrite through the worker, and explicitly send the exact draft to the form.
- Candidate-backed drafts use `JOB_RUN_APPROVE_SUGGESTION`; manual drafts use `JOB_RUN_APPLY_DRAFT`. A failed apply or rewrite retains the draft and reports the error in the panel status area.
- Opaque candidate values keep the existing disclosure-only treatment and expose no draft, rewrite, or apply controls.
- Drafts are scoped to application, page signature, and field, and are discarded when the run moves to another origin.

## Verification

Command:

```text
npm test -- tests/sidepanel.test.js
```

Result: 23 tests passed, 0 failed.

## Concerns

- The worker handlers for `JOB_RUN_REWRITE_ANSWER` and `JOB_RUN_APPLY_DRAFT` are intentionally outside this panel-only task. Until the worker task lands, the panel will retain a draft and show the worker's unavailable-action error in a live extension.

## Review fixes

- Removed the hidden legacy direct-approval controls. A saved candidate must now follow **Choose this answer** → **Send to form**.
- The panel clears a draft only after a successful response includes an updated `run`; incomplete responses retain the draft and show an error.
- Candidate-backed sends now use `candidateKind`, `sourceKey`, or non-empty `sourceKeys` to select the approval path, and retain plural source keys in the request.
- Rewrite and apply operations disable the draft and prompt while pending and use a draft revision guard, so a stale response cannot replace or clear a newer edit.
- Sends retain the original draft text; trimming is limited to empty and opaque-value checks.

### Review-fix verification

```text
npm test -- tests/sidepanel.test.js
```

Result: 28 tests passed, 0 failed.
