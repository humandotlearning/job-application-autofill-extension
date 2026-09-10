# Next Enhancements

This release improves local matching, review safety, AI recovery, and the side-panel workflow. The items below are intentionally **not implemented** yet.

## Priority 1 — Validate against real application sites

### Live ATS compatibility suite

**Outcome:** Measure behavior in real browser sessions for supported ATS products instead of relying only on synthetic fixtures.

**Work:** Maintain consented test applications for Workday, Lever, Ashby, Greenhouse, and SuccessFactors. Exercise repeated work history, delayed dropdowns, conditional questions, site-side validation rejections, narrow panels, and keyboard-only review.

**Acceptance:** Publish per-site detection recall, automatic-fill precision, review-candidate coverage, and failure classifications. Do not expand automatic-fill coverage until protected false-positive cases remain at zero.

### Representative accuracy corpus

**Outcome:** Replace the current small synthetic policy corpus with a privacy-safe, representative labeled corpus.

**Work:** Store field fingerprints, expected disposition, source identity, and answer correctness without applicant answers. Add false-positive and false-negative triage labels and regression gates.

**Acceptance:** Report changes by release. Keep automatic-fill precision at or above 99% on the protected corpus and verify a 25% relative reduction in missed supported required answers before broadening automation.

## Priority 2 — Improve retrieval without weakening safeguards

### Semantic retrieval

**Outcome:** Find valid saved evidence when wording differs substantially from the form question.

**Work:** Add an opt-in local embedding index with lexical retrieval as a fallback. Preserve entity, sensitivity, reuse-policy, option-label, and conflict gates before any result can be proposed.

**Acceptance:** Measure improved review-candidate recall separately from automatic fills. Semantic similarity alone must never authorize mutation.

### Richer profile facts and evidence provenance

**Outcome:** Give the user structured control over skills, projects, education, certifications, and employment achievements.

**Work:** Add profile editors with explicit confirmation, source dates, entity scopes, reuse policies, and duplicate/conflict handling. Keep each fact independently attributable when it reaches AI.

**Acceptance:** A user can inspect, correct, suppress, or revoke every fact used in a recommendation.

## Priority 3 — Make AI drafts easier to verify

### Claim-level draft verification

**Outcome:** Show which portion of a generated narrative comes from which saved fact.

**Work:** Require structured claims and evidence keys from the suggestion provider, then validate every factual clause locally. Flag unsupported phrasing before it reaches the review panel.

**Acceptance:** The panel distinguishes grounded facts, user-written text, and unsupported claims. Unsupported claims cannot be sent through the recommended-answer path.

### Provider resilience and optional local models

**Outcome:** Reduce dependence on a single remote provider while retaining the same review guarantees.

**Work:** Add provider health checks, exponential backoff, per-provider model compatibility checks, and an optional local-model adapter. Keep provider requests isolated behind the current schemas and caches.

**Acceptance:** A provider outage leaves local filling, saved-answer search, drafts, and manual review usable.

## Priority 4 — Broaden form support carefully

### Open-shadow-root and framework adapters

**Outcome:** Support modern controls that are not discoverable through the current DOM traversal.

**Work:** Add bounded open-shadow-root discovery and ATS-specific adapters only after recording representative fixtures. Continue to exclude closed roots, hidden fields, passwords, CAPTCHAs, uploads, and unrelated forms.

**Acceptance:** Every adapter has site fixtures covering discovery, fill, settlement, verification, and rejection recovery.

### More robust navigation recovery

**Outcome:** Resume safely when a site changes URL, frame, or form structure during an application.

**Work:** Add explicit checkpoint comparison and resume prompts that explain what changed. Never replay navigation, submit, or an approval automatically.

**Acceptance:** Reloads, redirects, and SPA transitions preserve drafts and require a fresh live destination check before a fill.

## Priority 5 — Optional product infrastructure

### Opt-in aggregate quality telemetry

**Outcome:** Learn which form patterns fail without collecting applicant answers.

**Work:** Export only aggregated, privacy-reviewed counters and failure categories with explicit user consent. Keep the default fully local.

**Acceptance:** Telemetry contains no raw answers, API keys, resumes, HTML, URLs, or identifiable field values.

### Hosted encrypted backup and collaboration

**Outcome:** Let users restore their approved profile and answer library across devices.

**Work:** Design end-to-end encryption, export/import compatibility, revocation, retention controls, and account recovery before storing profile data remotely.

**Acceptance:** The local-only workflow remains complete and usable when no account or network connection exists.

## Suggested order

1. Run live ATS compatibility and build the representative accuracy corpus.
2. Add semantic retrieval and richer fact provenance.
3. Add claim-level AI verification and resilience improvements.
4. Add adapters only where measured failures justify them.
5. Consider opt-in infrastructure after the local workflow is proven.
