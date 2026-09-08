### 5. Keep planner output pending until explicit selection/send

**Files:** `tests/service-worker.test.js`, `src/service-worker.js`, `src/sidepanel.js` (only if candidate metadata needs a display adapter).

1. Add a failing success-path planner test with an unresolved field and relevant saved evidence. Assert `JOB_RUN_START` leaves the page value blank, creates a readable suggestion candidate, and exposes the candidate under the field question rather than applying it automatically.
2. Add a failing planner composition test where a decision uses multiple `evidenceKeys`; assert the stored candidate retains every key plus an answer snapshot and approval rejects if any source answer changes before Send to form.
3. Change the planner branch in `applyPageDecisions` to convert validated `fill` decisions into `run.suggestions[field.id]` candidates (`sourceKeys`, `sourceAnswers`, `transformation`, reason/provenance, answer) and replace their page decision with `ask_user`. Do not send planner fills to `JOB_APP_APPLY`; keep unresolved diagnostics and `llmError` behavior intact.
4. Extend `approveSuggestion` to resolve `candidate.sourceKeys || [candidate.sourceKey]`, compare every current record answer with the stored snapshot, verify every key remains relevant to the destination field, and use all keys in the fill decision. Preserve existing candidate answer override, validation, sensitivity, learning, and stale-origin checks for local/draft/equivalent candidates.
5. Ensure planner candidates are rendered as readable evidence, are selectable only through the new draft workspace, and are removed from `run.suggestions` only after verified Send to form. Keep old run data with only `sourceKey` working through the fallback path.
6. Run the service-worker tests and the complete suite. Commit as `feat: require review before planner answers reach forms`.
