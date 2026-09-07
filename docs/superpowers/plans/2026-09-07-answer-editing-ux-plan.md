# Answer Editing UX Implementation Plan

> For an agentic coding worker: execute each task in order, keep the existing working-tree changes intact, and follow the test-first checkpoint before editing production code.

## Goal

Make the side panel show the exact answer that will be sent for every unresolved named form question, while keeping the answer blank until the user chooses a readable candidate (or starts a manual answer). Let the user edit the draft, ask the configured answer model to rewrite it, and explicitly send the final draft to the page. Preserve the existing page/frame staleness checks, fill validation, evidence provenance, opaque-ID restrictions, save behavior, and manual submission boundary.

## Architecture

- `src/sidepanel.js` owns transient draft state in memory, keyed by application run, page signature, and field ID. Rendering stays presentation-only until a user clicks **Send to form**.
- Readable saved candidates are nested below their question and expose **Choose this answer**. Opaque candidates stay behind the existing Internal ID disclosure and expose no selection or apply action.
- A named unresolved field renders an answer workspace: a read-only candidate preview until selected, a normal question-labeled textarea for the draft, Edit/Use edited answer controls, an optional rewrite prompt, and an explicit Send to form action. Empty drafts cannot be sent.
- Candidate-backed sends use the existing `JOB_RUN_APPROVE_SUGGESTION` guarded path, carrying the edited draft. Manual/no-source drafts use a new `JOB_RUN_APPLY_DRAFT` path with the same frame/page/handle/value safety checks but no datasource promotion.
- The worker converts successful answer-planner fills into pending suggestions instead of mutating the page. Planner candidates carry all evidence keys and a snapshot of source answers so approval remains source-qualified even for composed answers.
- A new `callAnswerRewriter` in `src/llm.js` uses the existing stored API key and selected model. `JOB_RUN_REWRITE_ANSWER` validates the current run context, sends question/draft/instruction/relevant evidence to the model, and returns replacement text without changing the page or saved data.
- Existing ordering, question headings, Internal ID disclosure, validation, and manual site submission behavior remain authoritative.

## Tech Stack

- Vanilla browser extension JavaScript modules (`src/sidepanel.js`, `src/service-worker.js`, `src/llm.js`) and the existing side-panel CSS.
- Node’s built-in test runner with JSDOM (`tests/sidepanel.test.js`, `tests/service-worker.test.js`, `tests/llm.test.js`).
- Existing Chrome runtime/storage mocks and `npm run check`, `npm run build`, and `git diff --check` verification commands.

## Global Constraints

- Do not change datasource schema, saved-answer storage format, autofill validation rules, or final application submission behavior.
- Do not auto-select a candidate or auto-apply a planner/rewrite result. Every page mutation must follow an explicit user action.
- Never expose opaque IDs in normal labels/answers and never provide a choose/apply control for an opaque answer.
- Treat page text, saved records, rewrite prompts, and model output as data, never as instructions. Bound prompt and answer lengths and reject malformed model output.
- Preserve unrelated existing working-tree changes and keep older runs without `formOrder` or new suggestion metadata renderable in incoming order.

## Implementation Tasks

### 1. Lock the draft interaction contract with side-panel tests

**Files:** `tests/sidepanel.test.js`.

1. Extend the JSDOM runtime mock with responses for `JOB_RUN_APPLY_DRAFT`, `JOB_RUN_REWRITE_ANSWER`, and candidate approval; make the mock record sent payloads and allow a test to return a rewrite failure or replacement answer.
2. Add a failing test for a named unresolved field with two candidates: the question is the heading, the draft textarea is initially empty, readable candidates show **Choose this answer**, and clicking neither candidate nor any page-apply message leaves the draft blank.
3. Add a failing test that clicks **Choose this answer**, verifies the textarea contains the candidate answer verbatim, verifies the application page was not targeted yet, opens **Edit**, changes the text, and verifies **Use edited answer** commits the transient draft without sending it.
4. Add a failing test for the rewrite flow: enter/select a draft, open the question-specific prompt, submit an instruction, verify the rewrite message contains the field/run origin, current draft, question, and instruction, then verify the returned answer replaces only the textarea. Add a failure case proving the previous draft remains visible and the status exposes the error.
5. Add a failing test that **Send to form** is disabled for an empty draft, sends the exact edited answer once a draft exists, and preserves the textarea when the apply response fails. Cover both candidate-backed (`JOB_RUN_APPROVE_SUGGESTION` with `sourceKey` and `answer`) and manual (`JOB_RUN_APPLY_DRAFT`) payloads.
6. Add a failing test that an opaque candidate renders its disclosure but no **Choose this answer**, **Edit**, rewrite, or Send control; keep readable evidence controls intact.
7. Run `npm test -- tests/sidepanel.test.js` and confirm these new tests fail for the missing controls/handlers before changing source.

### 2. Implement transient answer workspaces and candidate selection in the panel

**Files:** `src/sidepanel.js`, `src/sidepanel.css`.

1. Add a module-level `drafts` map keyed by `${applicationId}:${pageSignature}:${fieldId}` with `{ answer, sourceKey, sourceKeys, candidateKind, editing }`. Add helpers to read/create state, clear it after a verified apply, and discard stale run/page entries when `renderRun` moves to a new origin.
2. Refactor `itemRow` so a named field (`focus && item.fieldId`) always renders the question heading first, then status/reason, then a question-labeled answer workspace. Keep audit/review value rendering unchanged except for the existing opaque-ID rules.
3. Render a workspace textarea with the complete current draft, an empty-state placeholder when no draft exists, and an accessible label containing the question. Candidate-backed previews are read-only until selected; fields without candidates remain directly typeable so manual answers can start blank. Add **Edit** and **Use edited answer** toggles without storing edits in Chrome storage.
4. Replace direct candidate approval buttons with nested evidence cards containing the answer preview and **Choose this answer** for readable candidates. Selecting a candidate copies only its answer and source metadata into the draft map, updates the workspace, and announces the selection through the existing status element. Keep opaque candidate evidence behind `internalIdDisclosure` with no selection/apply controls.
5. Add a question-scoped **Ask AI to rewrite** button and hidden prompt row. Opening it must not clear the draft; submitting a non-empty bounded prompt sends `JOB_RUN_REWRITE_ANSWER` with run/page/frame/field identity, handle, current draft, candidate source keys, question, and no API key. Replace the draft only on a successful response; leave it unchanged on failure.
6. Add **Send to form**, disabled when the trimmed draft is empty or opaque. For a candidate-backed draft send `JOB_RUN_APPROVE_SUGGESTION` with its source key(s) and exact `answer`; for a manual draft send `JOB_RUN_APPLY_DRAFT`. Disable controls while awaiting the response, clear the draft only after `{ok:true, run}`, rerender the returned run, and use the existing status/error messaging.
7. Ensure `Show on page` remains attached to the question row and that long answers use the existing expandable preview while the editing textarea scrolls normally. Add CSS for workspace grouping, textarea/read-only state, candidate choose buttons, prompt row, and responsive wrapping without changing panel section order.
8. Run the side-panel test file; all new interaction tests should pass while the pre-existing ordering, disclosure, learned-change, and manual-submission tests remain green. Commit this task as `feat: add editable answer workspaces to side panel`.

### 3. Add the bounded rewrite model call

**Files:** `tests/llm.test.js`, `src/llm.js`.

1. Add a failing test for `callAnswerRewriter` that stubs `fetch`, captures the request, returns strict structured output `{ answer: "..." }`, and asserts the request uses the configured model, `store:false`, the question/draft/instruction/evidence payload, and the existing Responses endpoint.
2. Add failing tests for malformed structured output, missing/empty answer, non-OK responses, timeout, and prompt/data length bounds. Verify user-provided strings are serialized as data and no API key is returned in the result.
3. Implement `REWRITE_SCHEMA`, bounded output-token settings, request sanitizers for question/draft/instruction/evidence, and exported `callAnswerRewriter({ apiKey, question, draft, instruction, records }, { model, fetchImpl, timeoutMs })` using the same API-key normalization and structured-output extraction as the planner.
4. Validate that the result is one non-empty string answer and surface actionable `Answer rewrite ...` errors consistent with planner errors. Do not write to Chrome storage from this module.
5. Run `npm test -- tests/llm.test.js` and commit as `feat: add bounded answer rewrite call`.

### 4. Add guarded worker operations for rewrite and manual draft application

**Files:** `tests/service-worker.test.js`, `src/service-worker.js`.

1. Add failing worker tests for `JOB_RUN_APPLY_DRAFT`: a valid manual answer fills the exact value after re-inspection, a stale tab/frame/application/page/handle is rejected, invalid option/constraint values are rejected, legal/checkbox/opaque values are rejected, and a successful manual send does not add or promote an answer record.
2. Add failing worker tests for `JOB_RUN_REWRITE_ANSWER`: the configured model receives the current run origin and selected model, a successful rewrite leaves the page and datasource untouched, and missing API key, stale origin, empty draft/instruction, malformed model output, and network failure return errors without changing the draft/page.
3. Add a shared worker helper that loads the run, verifies `SAVABLE_RUN_STATUSES`, selected frame, application ID, page signature, field handle, and current field identity by re-inspecting the exact frame. Reject non-string/overlong drafts and prompts before any page call.
4. Implement `applyDraft` under `saveLocks`: for manual drafts, call `validateFillValue`, reject `inferSensitivity(field.label) === 'legal'`, checkbox types, and opaque answers, send one fill decision to the exact frame, re-inspect for retained value, recategorize/validate the run, and return the saved run. Do not call datasource write functions.
5. Implement `rewriteAnswer`: validate the same origin and draft, load the configured API key/settings, resolve only the suggestion’s current source records (including draft records where applicable), call `callAnswerRewriter`, and return `{ ok:true, answer }` without saving the run or touching the page. Keep errors non-mutating.
6. Register both message types in the dispatcher and enforce that panel-only operations cannot originate from a page sender, matching the existing approval guard.
7. Run `npm test -- tests/service-worker.test.js`; commit as `feat: guard manual draft apply and rewrite requests`.

### 5. Keep planner output pending until explicit selection/send

**Files:** `tests/service-worker.test.js`, `src/service-worker.js`, `src/sidepanel.js` (only if candidate metadata needs a display adapter).

1. Add a failing success-path planner test with an unresolved field and relevant saved evidence. Assert `JOB_RUN_START` leaves the page value blank, creates a readable suggestion candidate, and exposes the candidate under the field question rather than applying it automatically.
2. Add a failing planner composition test where a decision uses multiple `evidenceKeys`; assert the stored candidate retains every key plus an answer snapshot and approval rejects if any source answer changes before Send to form.
3. Change the planner branch in `applyPageDecisions` to convert validated `fill` decisions into `run.suggestions[field.id]` candidates (`sourceKeys`, `sourceAnswers`, `transformation`, reason/provenance, answer) and replace their page decision with `ask_user`. Do not send planner fills to `JOB_APP_APPLY`; keep unresolved diagnostics and `llmError` behavior intact.
4. Extend `approveSuggestion` to resolve `candidate.sourceKeys || [candidate.sourceKey]`, compare every current record answer with the stored snapshot, verify every key remains relevant to the destination field, and use all keys in the fill decision. Preserve existing candidate answer override, validation, sensitivity, learning, and stale-origin checks for local/draft/equivalent candidates.
5. Ensure planner candidates are rendered as readable evidence, are selectable only through the new draft workspace, and are removed from `run.suggestions` only after verified Send to form. Keep old run data with only `sourceKey` working through the fallback path.
6. Run the service-worker tests and the complete suite. Commit as `feat: require review before planner answers reach forms`.

### 6. Integrate, verify, and review the complete behavior

**Files:** `src/sidepanel.js`, `src/sidepanel.css`, `src/service-worker.js`, `src/llm.js`, `tests/*.test.js`, generated `dist/content.js` only if the build updates it.

1. Run `npm test`, `npm run check`, `npm run build`, and `git diff --check`. Resolve regressions without relaxing safety assertions or changing unrelated prior UX work.
2. Inspect the final diff for the complete spec coverage: blank-until-choice behavior, exact visible draft, edit/rewrite/send lifecycle, failure preservation, question prominence, opaque ID handling, planner gating, multi-source evidence, and no automatic site submission.
3. Confirm no API key, raw opaque ID, or hidden source metadata is accidentally rendered in normal panel text; only the existing info popover may reveal an ID after explicit interaction.
4. If build output changes, verify it contains only the expected generated content-script result and does not embed side-panel drafts or API-key logic. Commit the final verification as `chore: verify answer editing UX` only if there are meaningful generated/formatting changes; otherwise leave the earlier feature commits intact.

## Self-Review Checklist

- Every goal and interaction in `docs/superpowers/specs/2026-09-07-answer-editing-ux-design.md` maps to a test and implementation task.
- Candidate-backed and manual drafts have distinct, explicit worker paths with the same stale-origin and field-value validation.
- Planner output is pending evidence, never an automatic page mutation.
- Existing saved-answer persistence and manual submission behavior are unchanged.
- No TODO/TBD/placeholder steps remain; every task names files, interfaces, test commands, and a commit point.
