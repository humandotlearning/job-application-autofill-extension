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
