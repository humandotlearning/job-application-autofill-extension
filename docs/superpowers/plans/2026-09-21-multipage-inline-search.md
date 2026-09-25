# Multi-page forms and inline search implementation plan

> **For agentic workers:** Use executing-plans to implement each checked task.

**Goal:** Detect application page changes, expose an explicit current-page fill action, and verify LinkedIn keyword search.
**Architecture:** Keep existing run and message protocols. Content reports structural form changes; the worker refreshes the current page without filling until requested. Keyword search remains local.
**Tech Stack:** Chrome extension, JavaScript, Node test runner, jsdom.

## Constraints
- Preserve user-entered values, site authorization, selected-frame guards, and manual final submission.
- No new dependencies. Do not commit. Implement in the isolated worktree, then copy verified changes to a local fix branch in the original extension folder.

### Task 1: Multi-page forms
- [x] Trace content notifications, worker navigation and validation, and panel actions.
- [x] Baseline: `npm test` — 518 passing.
- [x] Add worker regressions: manual navigation refreshes stale fields without fills; explicit CHECK_PAGE fills the new page; duplicate notifications do not advance page count.
- [x] Add panel regression: page_changed primary action and visible refill button send JOB_RUN_CHECK_PAGE.
- [x] Add bundled-content regression: swapping form controls triggers JOB_APP_NAVIGATED; ordinary value edits do not.
- [x] Implement debounced structural change notifications while active; reuse validatePageOnly for manually changed pages and processPage for approved Next.
- [x] Invalidate page suggestions and waiting label on signature changes; show Fill this page and an always accessible refill action.
- [x] Run `node --test tests/service-worker.test.js tests/sidepanel.test.js tests/bundle-runtime.test.js`.

### Task 2: Inline search
- [x] Trace focus, debounce, worker inspection, retrieval, and approval using LinkedIn cases.
- [x] Reproduce any defect before changing behavior; add regression coverage for the defect.
- [x] Keep local keyword search independent of AI and retain current-field acceptance checks.
- [x] Run `node --test tests/inline-autofill.test.js tests/retrieval.test.js` plus relevant worker tests.

### Task 3: Delivery
- [x] Run `npm run build`, `npm run check`, and `npm test`.
- [x] Review final diff for stale-state regressions and unrelated changes.
- [x] Provide tested outcome and precise extension reload instructions with live-site limitations.

## Verification
- Build and syntax checks passed. Full suite: 524 tests passed, zero failures.
- Independent review findings resolved: selected destination replacement, open shadow roots, reused label text nodes.
- Inline LinkedIn keyword lookup passes local UI and worker tests; one DOM traversal replaces three per normal inline inspection. Synthetic measured improvement about 30%; live HPE latency remains unverified.
- A different top-level pathname retains the existing explicit Fill this form restart requirement.
