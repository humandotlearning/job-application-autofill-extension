# Lilly Page Detection and Per-Page Saving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect Lilly-style application pages with utility footer links and save current page values locally at any active step.

**Architecture:** Limit utility-frame scoring to page/frame metadata, leaving action text available only for positive application cues. Extend the existing save handler to recapture the page while preserving non-final run state, then expose it as a secondary panel action.

**Tech Stack:** Manifest V3 Chrome extension, JavaScript ES modules, Node.js test runner, JSDOM.

## Global Constraints

- Saving must never submit or navigate the application site.
- Existing final-page `answers_saved` behavior remains unchanged.
- The working tree already contains unrelated changes; touch only this feature's files.

---

### Task 1: Add worker regression coverage

**Files:**
- Modify: `tests/service-worker.test.js`
- Modify: `src/service-worker.js`

- [ ] Add a Lilly-like page with a Next action plus a `Careers website cookie settings` footer action, and assert the worker selects it.
- [ ] Run `node --test tests/service-worker.test.js` and verify the test fails because action labels currently trigger the utility-frame penalty.
- [ ] Score utility hints from page/frame metadata rather than all action labels, then rerun the focused test.
- [ ] Add a manual-value page with a required field still missing; save it and assert the current state is retained, filled values persist, and no submit message is sent.
- [ ] Run the focused worker test and verify it passes.

### Task 2: Expose per-page saving in the panel

**Files:**
- Modify: `tests/sidepanel.test.js`
- Modify: `src/sidepanel.js`

- [ ] Add a page-ready panel test that expects a visible `Save filled values` control and its save message.
- [ ] Run `node --test tests/sidepanel.test.js` and verify it fails because the secondary save action is hidden.
- [ ] Show the secondary action for active non-final states, preserve the primary action, and adjust save status copy.
- [ ] Rerun the focused panel test and verify it passes.

### Task 3: Build and verify

**Files:**
- Modify/generated: `dist/content.js` only if the build regenerates it

- [ ] Run `npm test`.
- [ ] Run `npm run check` and `npm run build`.
- [ ] Run `git diff --check` and inspect only the feature files plus generated output.
