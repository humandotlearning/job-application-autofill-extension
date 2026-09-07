# Action Required UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace opaque saved-answer identifiers with an explicit manual next step for required fields.

**Architecture:** The side panel gets a presentation-only detector for long hexadecimal identifiers. Rendering excludes those candidates from approval controls and adds an actionable explanation to the field issue. The worker and datasource formats remain unchanged.

**Tech Stack:** Manifest V3 extension JavaScript, JSDOM, Node test runner.

## Global Constraints

- Do not alter answer capture, storage, approval validation, or application submission behaviour.
- Hide only values that are 24 or more hexadecimal characters; preserve human-readable evidence controls.
- Use plain, action-first copy that names the blocked field and ends with **Check again**.

---

### Task 1: Render an actionable required-field pause

**Files:**

- Modify: `C:\Users\nithi\job-application-autofill-extension\tests\sidepanel.test.js`
- Modify: `C:\Users\nithi\job-application-autofill-extension\src\sidepanel.js`

**Interfaces:**

- Consumes: `run.actionRequired` items with `label`, `fieldId`, and `suggestion.candidates`.
- Produces: readable candidate controls unchanged; opaque candidate values become manual-only guidance.

- [x] **Step 1: Write the failing test**

```js
test('panel hides opaque saved values and directs the applicant to complete the required field', async () => {
  const opaqueValue = '5ec015e5642301ec004c2eaa25504002';
  const suggestion = {
    tabId: 7, frameId: 3, applicationId: 'run-one', pageSignature: 'page-one',
    field: { id: 'phone_type', handle: 'handle-one' },
    candidates: [{ sourceKey: 'phone_type', sourceQuestion: 'Phone Device Type', answer: opaqueValue, provenance: 'user', kind: 'draft' }],
  };
  const harness = await setupPanel({ run: { status: 'waiting_user', waitingLabel: 'Phone Device Type', actionRequired: [{ fieldId: 'phone_type', label: 'Phone Device Type', suggestion }], optionalUnresolved: [], reviewRequired: [], audit: [] } });
  try {
    const list = harness.dom.window.document.querySelector('#action-required-list');
    assert.match(list.textContent, /choose a value for Phone Device Type on the application page/i);
    assert.doesNotMatch(list.textContent, new RegExp(opaqueValue));
    assert.equal([...list.querySelectorAll('button')].some((button) => /saved answer|edit and use|approve edited/i.test(button.textContent)), false);
  } finally { harness.cleanup(); }
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/sidepanel.test.js`

Expected: FAIL because the raw opaque value and saved-answer controls render.

- [x] **Step 3: Write minimal implementation**

```js
function isOpaqueAnswer(value) {
  return /^[a-f\d]{24,}$/i.test(String(value ?? '').trim());
}

// In itemRow, skip opaque candidates and add this detail to the field:
// `Choose a value for ${item.label} on the application page, then click Check again.`
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/sidepanel.test.js`

Expected: PASS with all side-panel tests green.

- [x] **Step 5: Run full verification**

Run: `npm test` and `npm run check`

Expected: both commands exit 0.

- [x] **Step 6: Commit**

```bash
git add src/sidepanel.js tests/sidepanel.test.js docs/superpowers/plans/2026-09-07-action-required-ux.md
git commit -m "fix: clarify required field actions"
```
