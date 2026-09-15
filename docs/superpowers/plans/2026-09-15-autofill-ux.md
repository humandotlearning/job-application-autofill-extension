# Autofill UX and reliability implementation plan

> For agentic workers: execute bounded tasks through the user-requested Sol/Luna delegation; integrate and verify in the coordinator worktree.

**Goal:** Reliable, intuitive job application filling with minimal clicks across the supplied forms.

**Architecture:** Fix shared concept matching and panel actions, preserve existing review and submission boundaries, and verify rendered controls separately from synthetic fixtures.

**Tech stack:** Manifest V3, JavaScript, Node test runner, jsdom.

## Constraints

- Never submit applications; preserve existing form values and live profile edits.
- Prefer small shared fixes and existing dependencies.
- Use Luna for routine investigation and Sol for bounded review.
- Check progress every 15 minutes with the thread heartbeat.

## Work and evidence

- [x] Reproduce missed GitHub profile URL/link labels and polite LinkedIn prompts.
- [x] Extend `src/concepts.js`; regressions in `tests/core.test.js`.
- [x] Prevent GitHub profile reuse for username/repository questions; explicit GitHub URL textareas still match.
- [x] Repair reason-only waiting-state primary action in `src/sidepanel.js`; test Check again dispatch.
- [x] Make automatic-page-advance guidance accurate; test setting changes.
- [x] Install existing locked dependencies; run `npm test` (435 passing), `npm run check`, and `npm run build` on initial integrated changes.
- [x] Resolve unconfirmed bundled public profile links without promoting unrelated legacy answers or overwriting edits. Seed-derived exact matching, one-time migration, and existing-install persistence are tested.
- [x] Preserve profile and learning inbox during datasource reads: Chrome returns only requested storage keys. A corrected storage mock reproduced preference resets; regression now checks custom employer/phone defaults and inbox backup preservation.
- [x] Filter malformed and wrong-purpose GitHub/LinkedIn profile values through shared matching/retrieval. Keep valid differing profiles for review and leave saved records unchanged. Tests cover usernames, repository/portfolio URLs, credentials, valid query strings, and encoded profile names.
- [ ] Verify the current source build on live Lever and Greenhouse forms. Browser access recovered: the installed extension filled both links through inline review on Lever, but its version is not established. Greenhouse restored existing values and inline correctly kept them. Whole-page Fill and the `autofill-ux-3` build still need live verification.
- [ ] Check delayed dropdowns, required uploads, dynamic pages, and actionable failures against supplied form evidence; add regressions for demonstrated failures.
- [ ] Count actual interactions and document remaining required manual steps.
- Live baseline: Lever GitHub and LinkedIn each required three clicks (focus, select, confirm). Edit in panel returned a manual toolbar fallback. Saved candidate format problems are being corrected; no before/after click reduction has been verified yet.
- [x] Sol final review found no actionable correctness issues. Checks pass for the final implementation.

Latest verification: 439 tests pass; syntax check and build pass. Synthetic discovery/fill/readback confirms both links, preserves an edited URL, and does not submit. Installed inline behavior and baseline click counts were observed on Lever; current-build whole-page behavior and click reduction remain unverified.

## Coordination

### Current blocker

The implementation is built and tested, but the loaded Chrome extension's source directory/version and toolbar panel are not accessible through the available browser controls. The inline **Edit in panel** path explicitly requests a manual toolbar click. This has prevented current-build whole-page verification across multiple goal turns. The user has been asked to open the extension toolbar panel on the retained Lever tab; no answer to that step has arrived. Do not repeatedly recreate tabs, rerun passing tests, or claim completion while waiting. Resume by confirming the loaded source/build, then verify whole-page filling and count interactions without submitting or overwriting existing form values.

- Coordinator: `01a0a4b9-eb85-7063-ae54-34c2232d130b`.
- Luna form coverage: `01a0a4d7-1d4e-72b3-ba3a-fc8bf5d39117`.
- Sol integration review: `01a0a4d7-ae19-73e1-a4df-b662bc2f527d`.
- Heartbeat: `autofill-ux-progress-check`, active every 15 minutes.

## Live evidence limits

The coverage task reports usable Lever 100ms/Neuron7 and Greenhouse Point72/Twilio application forms. Other supplied links include job-detail entry points, an expired SmartRecruiters session, a Teamtailor loading modal, and a Linde application already completed by the user. These observations do not establish that the extension fills those forms successfully. Do not restart or submit the completed application.


## Workday follow-up — 0.1.5

- Observed First Advantage My Information: Street empty, Address Line 2 populated, Locality populated, postcode/state empty. No live values changed or submitted. The intended address components remain awaiting user clarification.
- Fixed numbered address and local-language concept separation, including a guard against misleading aliases copying ordinary city values into City - Local. Synthetic Workday fixture verifies fill/readback, blank local fields, and preservation of an existing Line 2. State fixture starts empty; it does not reproduce Workday's custom dropdown.
- Improved inline popup contrast, status visibility, scrolling and persistent blue confirmation. Chrome visual QA used the actual component with synthetic saved answers in tests/fixtures/inline-visual.html.
- Verification: 442/442 tests pass, syntax check and build pass. Release 0.1.5, content marker autofill-ux-4.
- Remaining: installed Workday inline lookup reported a changed destination; source/version remains unverified. Clearer error copy is not a runtime fix. Whole-page current-build verification and click reduction remain open.
