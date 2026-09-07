# Task 1 report

Status: DONE_WITH_CONCERNS

Added the side-panel interaction contract tests and extended the JSDOM Chrome runtime mock with configurable apply, approval, and rewrite responses. New tests cover blank-until-choice, transient candidate selection/editing, rewrite success and failure preservation, candidate-backed and manual Send to form payloads, and opaque candidate restrictions.

## Verification

Command: `npm test -- tests/sidepanel.test.js`

Result: 17 existing tests pass; 6 new tests fail as expected because the production answer workspace controls and handlers are not implemented yet. The opaque-candidate restriction test passes against the current implementation because it asserts the absence of the new controls.

## Expected selectors and payloads

The tests use these semantic hooks: `[data-answer-draft]`, `[data-choose-answer]`, `[data-edit-answer]`, `[data-use-edited-answer]`, `[data-rewrite-answer]`, `[data-rewrite-prompt]`, `[data-submit-rewrite]`, and `[data-send-answer]`.

Rewrite messages are expected to carry `applicationId`, `pageSignature`, `fieldId`, `question`, `draft`, and `instruction`. Candidate-backed sends are expected to use `JOB_RUN_APPROVE_SUGGESTION` with `sourceKey` and exact `answer`; manual sends use `JOB_RUN_APPLY_DRAFT` with `fieldId` and exact `answer`.

## Concern

The failure test currently expects the panel status text to expose `Rewrite unavailable`; the eventual renderer should preserve the prior draft while surfacing that error through the existing status/error region.

## Review fixes

Strengthened the interaction assertions so candidate selection and editing explicitly prove that no page-mutation message (`JOB_APP_APPLY`, `JOB_RUN_APPLY_DRAFT`, or `JOB_RUN_APPROVE_SUGGESTION`) is sent before the user clicks **Send to form**. Candidate-backed sending now asserts exactly one approval message, its source key, exact answer, and surfaced apply failure. Added a manual Send-to-form failure test that asserts exactly one guarded apply message, exact payload, draft preservation, and visible error status.

## Review-fix verification

Command: `npm test -- tests/sidepanel.test.js`

Result: 17 existing tests pass; 6 new contract tests fail as expected while the production answer workspace is still unimplemented. The new failure count includes the manual apply-failure case.
