# General Question Detection and Answer Reuse Implementation Plan

> **For Hermes:** Implement task-by-task with strict RED–GREEN–REFACTOR and independent spec/code review. Load the relevant implementation skills before execution.

**Goal:** Reuse previously confirmed application answers across differently structured and worded forms without requiring re-entry or inventing facts.

**Architecture:** Separate field-question extraction, semantic equivalence, evidence retrieval, and user approval. Exact equivalents reuse confirmed records; related experience answers become source-backed suggestions rather than automatically asserted qualifications. Retain global reusable records and per-tab application state as separate scopes.

**Tech Stack:** Manifest V3 Chrome extension, JavaScript modules, chrome.storage, Node test runner, jsdom, existing optional OpenAI Responses planner.

## Scope and known evidence

Workspace: `C:/Users/nithi/job-application-autofill-extension`.

Observed on Beghou's Lever form: custom textarea question headings reside in sibling divs, not associated HTML labels. `src/form-engine.js:labelFor` falls back to `cards[UUID][fieldN]`. Radio labels can be individual option text. Consequently matching and sensitivity inference lose the question meaning.

The installed database contained confirmed notice-period and expected-CTC records. Current compensation exists as `current_salary`, with Current CTC wording in application drafts. Production ML experience exists under differently worded questions. A diagnostic with corrected labels recovered notice period and expected CTC but not salary/CTC or narrative experience.

Pre-existing modifications in `src/form-engine.js`, `tests/form-engine.test.js`, and `dist/content.js` implement custom-widget changes. Preserve them; do not reset, overwrite, or attribute them to this task. No user answers or Chrome database snapshots belong in Git. Existing scratch diagnostics contain private data and must remain outside project fixtures.

This document is a plan, not an implementation or claim that the installed extension has changed.

## Design decisions

### 1. Extract a question, not arbitrary nearby text

Retain native label and explicit ARIA precedence for ordinary controls. For radio groups, prefer the group's question (legend, aria-labelledby, or unique local heading) and retain individual option labels separately.

Add a bounded nearest-question resolver shared by native controls and custom widgets:
- Search the nearest logical field wrapper for one unambiguous label/heading candidate.
- Consider preceding sibling headings and wrapper label text; use a small Lever adapter for `.application-label .text` where generic semantics are absent.
- Exclude input values, options, help/error messages, hidden text, buttons, and unrelated section headings.
- Stop at form/section boundaries, competing controls, or ambiguous question candidates. Never scan the entire form for the closest-looking string.
- Preserve machine name/id as identity, not as the semantic label. Record `labelSource` and `labelConfidence` in descriptors so failure is explainable.
- Use the same descriptor for matching, review, capture, and learning. Low-confidence/opaque labels must not be promoted into reusable semantic aliases.

### 2. General equivalence layer, with distinct meanings preserved

Introduce `src/concepts.js` as the single maintained registry of canonical concepts and equivalent phrases. It must be data-driven, not a growing collection of special cases in the fill engine.

Initial families: existing identity/link concepts; phone/mobile; current employer/company; current location/city when compatible; notice period; availability/start date as separate concepts; current/expected compensation; domain-specific experience tags. Strip only safe question boilerplate such as “Please enter your …”, punctuation and required markers.

Use meaning facets to prevent false matches:
- Current versus expected versus previous compensation.
- Total CTC versus base/fixed/variable compensation.
- Currency and annual/monthly/hourly units.
- Notice period versus a calendar start date.
- Current location versus willingness to relocate/work in a location.
- Overall AI experience versus LLM-agent experience versus pharma experience.

Generic “Current CTC” may retrieve the saved “current salary” explanation when the requested scope is compatible. Do not convert a bare `60` into `60 LPA`, compute fixed/variable splits, or infer currency. Incompatible or unstated units on numeric-only fields require review instead of silent conversion.

Canonicalize at lookup time first. Do not rename persisted keys en masse: evidenceKeys, history, backup merges, and scoped records depend on stable identifiers. Treat legacy keys, record.question, concept, and aliases as candidate metadata; pending/conflicting records remain ineligible for automatic reuse.

### 3. Related evidence is not an exact answer

Introduce `src/retrieval.js` to rank eligible saved records using question, aliases, bounded answer text, and domain/action tags. Examples: ML/model training/deployment/production and computer vision. Apply scope, confirmation, sensitivity, negation, units, and conflict filters before ranking.

Keep separate APIs/results for exact equivalence and related evidence. Do not merely lower the current fuzzy threshold: that would fill plausible but wrong answers into unrelated fields.

For a new narrative question, offer existing relevant answers verbatim with source question, excerpt, provenance, and reason. Provide **Use this saved answer** and **Edit and use** actions. Do not require an API key for local retrieval. When the existing optional AI planner is used, retrieve a bounded relevant subset rather than all records; generated wording is a draft with evidence and explicit approval, not a newly verified fact.

For experience options, map a verified structured years value only when domain and threshold are unambiguous. A narrative “around 7 years working with AI” can be surfaced as evidence, but must not silently become a precise, verified years record. Above/below boundaries and exactly-six-years cases need tests. ML evidence must never fill Pharma Domain.

### 4. Learn approved reuse rather than asking again

On explicit approval of a true semantic equivalent, add the new question wording as an alias to the stable source record, preserving history and provenance. On edited/recomposed narrative approval, store a separate question-answer record with its evidence links rather than pretending all source questions are equivalent.

Expose relevant previous application drafts as **Previously entered, not yet saved for reuse** suggestions. Do not automatically promote every draft or label autofill output as a user-confirmed answer. Existing explicit Save semantics and conflict handling remain intact.

### 5. Explain every blank

Show one of: no reliable question label; saved answer requires confirmation; ambiguous/conflicting saved answers; incompatible units/options; relevant saved evidence available; no evidence found; optional AI unavailable/failed. Distinguish lack of a literal match from lack of data. Never claim that an answer is missing when a candidate is available for review.

## Ordered implementation tasks

For each behavior: add one regression, run it and verify the intended failure, implement minimally, rerun the target, then broaden coverage. Do not write all tests first and implement everything at once.

### Task 1: Baseline and sanitized reproduction

Files: `tests/fixtures/lever-custom-questions.html` (new), `tests/form-engine.test.js`.

1. Record `git diff` and run `npm test` plus `npm run check`; distinguish pre-existing failures.
2. Create a minimal sanitized fixture preserving the observed sibling-div structure for notice period, both compensation questions, ML narrative and two separate radio groups. Use synthetic answers and IDs.
3. Add a failing descriptor test asserting human-readable question labels and separate radio options.
4. Run `node --test tests/form-engine.test.js` and retain expected RED output.

### Task 2: Native label recovery

Files: `src/form-engine.js`, `tests/form-engine.test.js`.

1. Implement bounded sibling/wrapper recovery for text/textarea controls.
2. Confirm Notice Period is extracted and inferred as review-sensitive, while native labels still win.
3. Add ambiguity, neighboring-fields, hidden-heading, help-text and unrelated-form regressions one at a time.
4. Verify captured learned questions use semantic labels, not generated card IDs.

### Task 3: Radio and custom-widget question recovery

Files: `src/form-engine.js`, `tests/form-engine.test.js`, `tests/ats-fixtures.test.js`.

1. Add failing tests for two Yes/No groups on the same form.
2. Recover group questions without concatenating options or stealing another group's label.
3. Reuse the bounded resolver for custom widgets without regressing the pre-existing SuccessFactors changes.
4. Test native fieldset/legend and ARIA precedence, hidden duplicates and nested wrappers.

### Task 4: Canonical concept registry

Files: `src/concepts.js` (new), `src/core.js`, `tests/concepts.test.js` (new), `tests/core.test.js`.

1. Start with failing current-salary/current-CTC equivalent-label tests.
2. Add expected/desired compensation separately, with negative current-versus-expected tests.
3. Move existing identity/link aliases into the shared registry while keeping the public canonicalConcept API compatible.
4. Add general question-boilerplate handling and safe non-compensation aliases.
5. Test units, compensation components, entity scope, ambiguous aliases and unchanged legacy keys. Require review on uncertainty rather than relaxing the fuzzy cutoff.

### Task 5: Evidence-backed experience retrieval

Files: `src/retrieval.js` (new), `tests/retrieval.test.js` (new), `src/form-engine.js`.

1. Add a failing test retrieving a saved training/deployment narrative for a differently worded ML-model experience question.
2. Return ranked evidence and source keys without converting retrieval into an automatic fill decision.
3. Add negative tests for pharma, negated experience, short generic answers, company-specific motivation, employment-scoped facts and unresolved conflicts.
4. Add structured experience-option mapping only after domain/threshold tests exist. Unsupported mappings stay suggestions.

### Task 6: Suggestion state and explicit approval

Files: `src/service-worker.js`, `src/sidepanel.js`, `sidepanel.html`, `src/sidepanel.css`, `tests/service-worker.test.js`, `tests/sidepanel.test.js`.

1. Add tab-scoped candidate/evidence state to unresolved fields.
2. Render exact saved answer and source with Use/Edit actions, avoiding duplicate requests for already-known facts.
3. Approval must bind to tab, frame, navigation/application ID and current field handle. Reject stale approvals after navigation or rerender.
4. Validate destination type, options, units and constraints before applying; preserve existing values.
5. Sensitive or inferred suggestions require explicit approval. No automatic submission/navigation or consent selection.

### Task 7: Reuse learning and draft recovery

Files: `src/core.js`, `src/datasource.js`, `src/service-worker.js`, `tests/core.test.js`, `tests/datasource.test.js`, `tests/service-worker-datasource.test.js`.

1. Add a failing test showing an approved equivalent question becomes a reusable alias without changing the record key or losing provenance/history.
2. Make draft candidates available without silently promoting them; deduplicate identical candidates.
3. Preserve pending/conflicting states. Approved narrative edits become separate records, not false semantic aliases.
4. Test serialized writes and read-back, backup round trips, idempotent approval and cross-tab isolation.

### Task 8: Optional AI retrieval integration and diagnostics

Files: `src/llm.js`, `src/service-worker.js`, `tests/llm.test.js`, `tests/service-worker.test.js`, `src/sidepanel.js`.

1. Supply only bounded eligible evidence to optional AI planning.
2. Preserve evidence validation and treatment of page/record text as untrusted data.
3. If introducing synthesis, explicitly extend the decision schema and approval path; do not disguise synthesis as a validated copy transformation.
4. Test absent key, network failure, invalid evidence keys, unsupported synthesis, and no repeated API calls while the page state is unchanged.
5. Show useful local suggestions even when AI is absent or fails.

### Task 9: Integration, packaging and visible Chrome verification

Files: `tests/ats-fixtures.test.js`, `tests/extension-structure.test.js`, `scripts/build.mjs` if new modules require bundling changes, `README.md`, generated `dist/content.js`.

1. Run `npm test`, `npm run check`, `npm run build`, then `npm test` again so packaging tests exercise the fresh bundle.
2. Review the diff for private data, unrelated changes, host restrictions, scope leaks and accidental auto-promotion.
3. Verify new modules are bundled and the MV3 manifest/package loads correctly.
4. Run the sanitized Lever end-to-end fixture with saved-record equivalents and check exact label/value/source relationships, not merely nonempty fields.
5. Preserve the user's live page before extension reload; do not reload the application and lose unsaved values. Load the new extension code and rescan the same visible Chrome application tab.
6. Verify human-readable labels, exact notice/expected compensation matches, current-compensation suggestion and relevant ML evidence. Leave Pharma unresolved without supporting evidence. Do not apply sensitive/new narrative suggestions until approved.
7. Re-read exact form values and extension storage after approved changes. Test the newly learned wording in a second sanitized ATS fixture.
8. If native Chrome access/reload is blocked, report automated verification separately from live verification. Never claim the installed browser is fixed merely because tests pass.

## Acceptance criteria

- Lever custom questions and radio groups have correct semantic labels; ordinary native/ARIA labels do not regress.
- Matching is reusable across sites and phrases, not tied to Beghou or a fixed ATS allowlist.
- Current and expected compensation cannot cross-match; units/components and scope remain protected.
- Confirmed notice/expected-CTC values are recoverable without re-entry.
- Relevant existing experience answers are surfaced with evidence and one approval action instead of a blank/no-data message.
- Unsupported pharma or other qualifications are never inferred from general ML experience.
- Explicitly approved aliases survive backup/import and work on another site; pending drafts do not auto-promote.
- Per-tab state, existing-value preservation and final-submission boundaries remain intact.
- Full tests/check/build pass; live Chrome verification status is stated separately.

## Risks and release boundaries

The largest risk is wrong-answer reuse, not missed fills. Prefer explicit evidence suggestions over aggressive semantic autofill. Label recovery must be bounded to avoid promoting an option, error message or neighboring question. Existing API validation is deliberately restrictive; any new synthesis requires its own schema, tests and approval flow.

Do not use a bulk database migration or copy private Chrome records into fixtures. Do not commit/push pre-existing changes without reviewing ownership and scope. Implementation can proceed using these defaults without asking the user to restate their application answers.
