### 1. Lock the draft interaction contract with side-panel tests

**Files:** `tests/sidepanel.test.js`.

1. Extend the JSDOM runtime mock with responses for `JOB_RUN_APPLY_DRAFT`, `JOB_RUN_REWRITE_ANSWER`, and candidate approval; make the mock record sent payloads and allow a test to return a rewrite failure or replacement answer.
2. Add a failing test for a named unresolved field with two candidates: the question is the heading, the draft textarea is initially empty, readable candidates show **Choose this answer**, and clicking neither candidate nor any page-apply message leaves the draft blank.
3. Add a failing test that clicks **Choose this answer**, verifies the textarea contains the candidate answer verbatim, verifies the application page was not targeted yet, opens **Edit**, changes the text, and verifies **Use edited answer** commits the transient draft without sending it.
4. Add a failing test for the rewrite flow: enter/select a draft, open the question-specific prompt, submit an instruction, verify the rewrite message contains the field/run origin, current draft, question, and instruction, then verify the returned answer replaces only the textarea. Add a failure case proving the previous draft remains visible and the status exposes the error.
5. Add a failing test that **Send to form** is disabled for an empty draft, sends the exact edited answer once a draft exists, and preserves the textarea when the apply response fails. Cover both candidate-backed (`JOB_RUN_APPROVE_SUGGESTION` with `sourceKey` and `answer`) and manual (`JOB_RUN_APPLY_DRAFT`) payloads.
6. Add a failing test that an opaque candidate renders its disclosure but no **Choose this answer**, **Edit**, rewrite, or Send control; keep readable evidence controls intact.
7. Run `npm test -- tests/sidepanel.test.js` and confirm these new tests fail for the missing controls/handlers before changing source.
