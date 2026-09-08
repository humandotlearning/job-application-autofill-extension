### 4. Add guarded worker operations for rewrite and manual draft application

**Files:** `tests/service-worker.test.js`, `src/service-worker.js`.

1. Add failing worker tests for `JOB_RUN_APPLY_DRAFT`: a valid manual answer fills the exact value after re-inspection, a stale tab/frame/application/page/handle is rejected, invalid option/constraint values are rejected, legal/checkbox/opaque values are rejected, and a successful manual send does not add or promote an answer record.
2. Add failing worker tests for `JOB_RUN_REWRITE_ANSWER`: the configured model receives the current run origin and selected model, a successful rewrite leaves the page and datasource untouched, and missing API key, stale origin, empty draft/instruction, malformed model output, and network failure return errors without changing the draft/page.
3. Add a shared worker helper that loads the run, verifies `SAVABLE_RUN_STATUSES`, selected frame, application ID, page signature, field handle, and current field identity by re-inspecting the exact frame. Reject non-string/overlong drafts and prompts before any page call.
4. Implement `applyDraft` under `saveLocks`: for manual drafts, call `validateFillValue`, reject `inferSensitivity(field.label) === 'legal'`, checkbox types, and opaque answers, send one fill decision to the exact frame, re-inspect for retained value, recategorize/validate the run, and return the saved run. Do not call datasource write functions.
5. Implement `rewriteAnswer`: validate the same origin and draft, load the configured API key/settings, resolve only the suggestion’s current source records (including draft records where applicable), call `callAnswerRewriter`, and return `{ ok:true, answer }` without saving the run or touching the page. Keep errors non-mutating.
6. Register both message types in the dispatcher and enforce that panel-only operations cannot originate from a page sender, matching the existing approval guard.
7. Run `npm test -- tests/service-worker.test.js`; commit as `feat: guard manual draft apply and rewrite requests`.
