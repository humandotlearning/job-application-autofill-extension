# Task 4 Review: Guarded draft apply and rewrite

## Verdicts

- **Spec compliance: NEEDS FIX.** The worker correctly registers panel-only apply/rewrite routes, re-inspects the exact selected frame before either action, checks the run/page/handle snapshot, validates manual values, blocks opaque values and checkbox controls, keeps rewriting non-mutating, and keeps the API key in the worker. However, the legal-field block derives sensitivity from `field.label` alone, while the extension's canonical classifier deliberately includes the field ID. A legal field with a generic label can therefore be auto-filled through `JOB_RUN_APPLY_DRAFT`.
- **Task quality: NEEDS FIX.** The implementation is otherwise focused and the tests cover the primary happy and stale/error paths, but the missing ID-aware legal test leaves the safety boundary unproven and currently bypassable.

## Findings

### Critical

None.

### Important

- `src/service-worker.js:934` checks `inferSensitivity(field.label) === 'legal'`, omitting the inspected field ID (and any descriptor sensitivity). `inferSensitivity` is defined to classify both question and key, and the content-side fill path only treats a decision as legal when that ID-aware classifier is used. A required text control such as `id="privacy_attestation"`, label `"Confirm"` is therefore accepted by `applyDraft`, given `sensitivity: "safe"`, and filled by `JOB_APP_APPLY` even though it is a legal acknowledgement. Classify with `inferSensitivity(field.label, field.id)` (or preserve and honor descriptor sensitivity) when blocking and when constructing the decision, and add a worker test for the generic-label/legal-ID case. This restores the promised legal-field manual-only boundary.

### Minor

- `listedRunField(run, fieldId)` dereferences `run` before `guardedDraftField` checks whether it exists. A stale tab with no run still fails safely before any page operation, but returns a TypeError rather than the intended stale-draft message. Check `run` first for a deterministic user-facing error.
- `fieldOrigin` in the panel falls back to `currentRun.frameId`, which Task 4 now supplies for new runs, but older session runs only have `frame.frameId`; `currentRun.frame?.id` is not the stored property. A resumed pre-update manual draft will therefore fail its origin guard until the user checks the page again. Prefer `currentRun?.frame?.frameId` before the alias.

## Required checks

- Exact-frame re-inspection and stale origin/handle guard: satisfied for new runs.
- Manual value/opaque/checkbox validation and no datasource promotion: satisfied.
- Legal-field block: **not satisfied for legal field IDs with generic labels**.
- Rewrite evidence/model isolation and non-mutation: satisfied.
- Panel-only sender guard and dispatcher registration: satisfied.
- Run metadata and panel handles: satisfied for new runs; older persisted runs have the minor fallback issue above.
