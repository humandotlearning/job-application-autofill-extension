# Generic Custom Form Widget Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the extension recognize and safely fill common accessible custom choice controls on Workday and unfamiliar job sites without pausing for unrelated utility menus.

**Architecture:** Extend `src/form-engine.js` with a generic field-like custom-widget descriptor and an asynchronous DOM interaction path that opens a widget, waits briefly for its rendered options, matches one exact visible option, selects it, and verifies the displayed value. Keep the service worker’s existing inspect/apply/validate/capture/confirm lifecycle, changing only the blocker calculation so unresolved custom fields are reported through the same validation path. Keep native controls unchanged and rebuild `dist/content.js` from the tested source.

**Tech Stack:** Manifest V3 Chrome extension, JavaScript ES modules, generated classic content bundle, Node.js built-in test runner, and JSDOM fixtures.

## Global Constraints

- Candidate controls must be visible and satisfy an accessibility/structure-driven field-like contract; do not rely on Workday IDs, CSS classes, page order, or coordinates.
- Exact normalized option matches are required; partial, ambiguous, unavailable, or invalid matches remain manual.
- Utility menus outside the form/main content area must not block an application run.
- Shadow-root controls, cross-origin iframes, CAPTCHA, login, file uploads, ambiguous widgets, and controls without safe matches remain manual pause points.
- Final submission continues to require one explicit confirmation and must occur at most once.
- Custom-widget values are captured and learned through the existing final-confirmation path.

## Reference review

The referenced `ritsth/job-autofill-extension` repository uses per-site adapters for Greenhouse, Lever, and Workday, plus a shared option resolver that compares every option by normalized text/value before considering a unique fuzzy match. Its Workday adapter is useful as evidence that Workday-specific DOM contracts exist, but copying its site-specific adapter architecture would not satisfy this project’s unfamiliar-site requirement. This plan borrows the shared exact-first option-resolution principle and keeps the implementation in the existing site-agnostic form engine; no upstream selectors, profile schema, or AI flow are copied.

---

### Task 1: Discover field-like custom choice controls and validate their state

**Files:**
- Modify: `src/form-engine.js:50-150,334-375`
- Test: `tests/form-engine.test.js`

**Interfaces:**
- Consumes: existing `isVisible`, `labelFor`, `fieldIdentity`, `fieldOptions`, and `fieldValue` helpers.
- Produces: `collectFieldDescriptors(document)`, `inspectDocument(document)`, `validateDocument(document)`, and `collectAnswerRecords(document)` behavior that includes generic custom choice buttons as `type: 'select'` fields and uses their displayed value for validation/capture.

- [x] **Step 1: Write failing discovery and pause tests**

Add these tests after the existing field inspection tests:

```js
test('discovers selected custom listbox fields but ignores utility menus', () => {
  const document = makeDocument(`
    <button id="language" aria-haspopup="listbox">English</button>
    <main>
      <div>
        <span>Country</span>
        <button id="country" name="country" aria-haspopup="listbox" aria-label="Country India Required">India</button>
        <input type="text" value="country-id" aria-hidden="true">
      </div>
    </main>
  `);
  const inspection = inspectDocument(document);
  assert.deepEqual(inspection.fields.map((field) => field.id), ['country']);
  assert.equal(inspection.fields[0].type, 'select');
  assert.equal(inspection.fields[0].label, 'Country');
  assert.equal(inspection.fields[0].currentValue, 'India');
  assert.deepEqual(inspection.pauseReasons, []);
  assert.deepEqual(collectAnswerRecords(document).map(({ key, answer }) => ({ key, answer })), [
    { key: 'country', answer: 'India' },
  ]);
});

test('pauses for an empty required custom choice field', () => {
  const document = makeDocument(`
    <main>
      <button id="previous-worker" name="previousWorker" aria-haspopup="listbox" aria-label="Have you worked here? Required">Choose one</button>
      <input type="text" value="" aria-hidden="true">
    </main>
  `);
  const inspection = inspectDocument(document);
  const validation = validateDocument(document);
  assert.equal(inspection.pauseReasons.includes('unsupported_widget'), true);
  assert.equal(validation.ok, false);
  assert.deepEqual(validation.requiredEmpty.map((field) => field.fieldId), ['previous-worker']);
});
```

- [x] **Step 2: Run the focused tests and verify they fail for the missing behavior**

Run:

```powershell
node --test tests/form-engine.test.js
```

Expected: the new tests fail because `collectFieldDescriptors` currently only returns native `input`, `textarea`, and `select` elements, and the current global pause selector does not distinguish utility menus from fields.

- [x] **Step 3: Implement generic custom-widget discovery**

Add helpers with these behaviors:

```js
function customWidgetElements(document) {
  return [...document.querySelectorAll('[role="combobox"], button[aria-haspopup="listbox"]')]
    .filter((element) => isVisible(element))
    .filter((element) => element.closest('form, main, [role="main"]') || element.parentElement?.querySelector('input, textarea, select'))
    .filter((element) => !element.closest('[aria-label="Language"], [aria-label="Settings"], [data-automation-id="utilityMenuButton"]'))
    .filter((element) => element.getAttribute('aria-label') || element.getAttribute('name') || element.parentElement?.querySelector('input, textarea, select'));
}

function customWidgetRequired(element) {
  return element.getAttribute('aria-required') === 'true'
    || /\brequired\b/i.test(element.getAttribute('aria-label') || '')
    || Boolean(element.required);
}

function customWidgetLabel(element) {
  const displayed = String(element.textContent || '').replace(/\s+/g, ' ').trim();
  const ariaLabel = String(element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
  const withoutState = ariaLabel.replace(/\b(?:required|optional)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const withoutValue = displayed && normalizeText(withoutState).endsWith(normalizeText(displayed))
    ? withoutState.slice(0, withoutState.length - displayed.length).trim()
    : withoutState;
  return withoutValue || ariaLabel || element.getAttribute('name') || element.id || '';
}
```

Integrate these candidates into field discovery after native fields, mark their descriptor type as `select`, use their visible text as `currentValue`, and deduplicate by element ID/name. Update `pauseReasons` to inspect only `customWidgetElements(document)` and add `unsupported_widget` only when a field-like widget is empty. Update `validateDocument` to add `requiredEmpty` entries for empty required custom widgets.

- [x] **Step 4: Run the focused tests and verify they pass**

Run:

```powershell
node --test tests/form-engine.test.js
```

Expected: all existing form-engine tests and both new discovery tests pass.

- [ ] **Step 5: Commit the discovery change**

```powershell
git add src/form-engine.js tests/form-engine.test.js
git commit -m "feat: discover accessible custom form fields"
```

### Task 2: Fill custom choice controls using exact rendered options

**Files:**
- Modify: `src/form-engine.js:135-215,269-330`
- Test: `tests/form-engine.test.js`

**Interfaces:**
- Consumes: the custom field descriptors from Task 1 and existing `normalizeText`, `validateFillValue`, and `dispatchFormEvents` helpers.
- Produces: asynchronous `applyDecisions(document, decisions)` behavior that opens a custom choice widget, waits briefly for its rendered listbox, compares every option by normalized text/value, selects one exact match, and returns a failed/unresolved result without guessing when no unique match exists.

- [x] **Step 1: Write failing interaction tests**

Add these tests:

```js
test('selects an exact option from a generic custom listbox after delayed rendering', async () => {
  const document = makeDocument(`
    <main>
      <button id="country" name="country" aria-haspopup="listbox" aria-label="Country Required">Choose country</button>
      <input type="text" value="" aria-hidden="true">
    </main>
  `);
  const button = document.querySelector('#country');
  button.addEventListener('click', () => {
    setTimeout(() => {
      const listbox = document.createElement('div');
      listbox.setAttribute('role', 'listbox');
      const option = document.createElement('div');
      option.setAttribute('role', 'option');
      option.textContent = 'India';
      option.addEventListener('click', () => {
        button.textContent = 'India';
        listbox.remove();
      });
      listbox.append(option);
      document.body.append(listbox);
    }, 10);
  });

  const field = inspectDocument(document).fields[0];
  const result = await applyDecisions(document, [{
    fieldId: field.id,
    action: 'fill',
    value: 'India',
    evidenceKeys: ['country'],
    confidence: 'high',
    sensitivity: 'safe',
    reason: 'Known country',
  }]);

  assert.equal(result.failed.length, 0);
  assert.equal(result.applied.length, 1);
  assert.equal(document.querySelector('#country').textContent, 'India');
});

test('does not choose an ambiguous custom option', async () => {
  const document = makeDocument(`
    <main><button id="country" aria-haspopup="listbox" aria-label="Country Required">Choose country</button></main>
  `);
  const button = document.querySelector('#country');
  button.addEventListener('click', () => {
    const listbox = document.createElement('div');
    listbox.setAttribute('role', 'listbox');
    for (const text of ['India', 'India']) {
      const option = document.createElement('div');
      option.setAttribute('role', 'option');
      option.textContent = text;
      listbox.append(option);
    }
    document.body.append(listbox);
  });

  const result = await applyDecisions(document, [{
    fieldId: 'country', action: 'fill', value: 'India', evidenceKeys: ['country'],
    confidence: 'high', sensitivity: 'safe', reason: 'Known country',
  }]);

  assert.equal(result.applied.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].reason, /unique exact option/i);
});
```

- [x] **Step 2: Run the focused tests and verify they fail**

Run:

```powershell
node --test tests/form-engine.test.js
```

Expected: the exact-selection test fails because `fillElement` currently treats the button as a text input path and cannot open/select a listbox option.

- [x] **Step 3: Implement the minimal custom selection path**

Add a custom-widget branch before the native select branch in `fillElement`. Because some unfamiliar sites render the listbox in a portal after the click, make `applyDecisions`, `fillElement`, and `setCustomChoiceValue` asynchronous and use a bounded wait of at most 750 ms for visible options; a timeout returns a manual failure.

```js
function optionText(element) {
  return String(element.textContent || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
}

function optionValue(element) {
  return String(element.getAttribute('data-value') || element.getAttribute('value') || '').trim();
}

function visibleListboxOptions(document) {
  return [...document.querySelectorAll('[role="listbox"] [role="option"]')]
    .filter((option) => isVisible(option));
}

function waitForListboxOptions(document, timeoutMs = 750) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      const options = visibleListboxOptions(document);
      if (options.length || Date.now() - startedAt >= timeoutMs) return resolve(options);
      setTimeout(check, 25);
    };
    check();
  });
}

async function setCustomChoiceValue(document, element, answer) {
  element.click();
  const expected = normalizeText(answer);
  const options = await waitForListboxOptions(document);
  const matches = options.filter((option) => normalizeText(optionText(option)) === expected || normalizeText(optionValue(option)) === expected);
  if (matches.length !== 1) return { ok: false, reason: 'The custom widget does not expose one unique exact option' };
  matches[0].click();
  const backingInput = element.parentElement?.querySelector('input, textarea');
  if (backingInput) dispatchFormEvents(backingInput);
  dispatchFormEvents(element);
  return normalizeText(fieldValue(document, element)) === expected
    ? { ok: true }
    : { ok: false, reason: 'The custom widget did not accept the selected option' };
}

async function fillElement(document, element, answer) {
  if (customWidgetElements(document).includes(element)) return setCustomChoiceValue(document, element, answer);
  if (element.tagName === 'SELECT') return { ok: setSelectValue(element, answer) };
  if (element.type === 'radio') return { ok: setRadioGroup(document, element, answer) };
  if (element.type === 'checkbox') return { ok: setCheckbox(element, answer) };
  return { ok: setTextValue(element, answer) };
}
```

Update `applyDecisions` to await `fillElement` and use its returned `{ ok, reason }` object in `result.failed`. Make `fieldValue` return the custom control’s displayed text. Resolve exact matches across every rendered option before clicking; do not accept a first-in-DOM match. If a listbox cannot be opened or there is not exactly one normalized match, report the returned reason and leave the field for manual completion.

- [x] **Step 4: Run the focused tests and verify they pass**

Run:

```powershell
node --test tests/form-engine.test.js
```

Expected: all form-engine tests pass, including delayed option rendering, exact selection, and ambiguity safety.

- [ ] **Step 5: Commit the interaction change**

```powershell
git add src/form-engine.js tests/form-engine.test.js
git commit -m "feat: fill accessible custom choice widgets"
```

### Task 3: Rebuild the extension and update user-facing documentation

**Files:**
- Modify: `README.md:20-85`
- Modify/generated: `dist/content.js`
- Test: `tests/extension-structure.test.js`

**Interfaces:**
- Consumes: tested source modules and the existing build script.
- Produces: a loadable `dist/content.js` bundle and documentation that accurately describes accessible custom-widget support and its manual fallback boundaries.

- [x] **Step 1: Add a documentation regression assertion**

Extend the structure test to assert that the generated content bundle contains the custom widget selector and the exact-match failure wording, ensuring the shipped bundle includes the source behavior.

- [ ] **Step 2: Run the assertion before rebuilding**

Run:

```powershell
node --test tests/extension-structure.test.js
```

Expected: the new assertions fail because the current generated bundle does not contain the custom-widget implementation.

- [x] **Step 3: Update the README and rebuild**

Change the boundaries/runtime text to say that common accessible custom choice widgets are supported, while unfamiliar, ambiguous, shadow-root, cross-origin, CAPTCHA, login, and upload controls remain manual. Then run:

```powershell
npm run build
```

Expected: `Built dist/content.js from 3 modules.`

- [x] **Step 4: Run the structure test after rebuilding**

Run:

```powershell
node --test tests/extension-structure.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit the generated bundle and documentation**

```powershell
git add README.md dist/content.js tests/extension-structure.test.js
git commit -m "docs: describe generic custom widget support"
```

### Task 4: Full verification and live-page smoke check

**Files:**
- Read-only verification: all project files

- [x] **Step 1: Run the full automated test suite**

Run:

```powershell
npm test
```

Expected: all tests pass with no failures.

- [x] **Step 2: Run syntax and build checks**

Run:

```powershell
npm run check
npm run build
```

Expected: both commands complete successfully and the bundle is regenerated from the current source.

- [x] **Step 3: Inspect the final diff and status**

Run:

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors; only the intended custom-widget implementation, tests, generated bundle, documentation, and plan/spec commits are present. Existing unrelated user changes must remain untouched.

- [ ] **Step 4: Perform a read-only smoke check on the Workday tab**

Reload the unpacked extension after rebuilding, inspect the current Workday page, and confirm that already-selected `Job Alert`, `India`, and `Mobile` controls do not produce an `unsupported_widget` pause. Do not submit the job application during verification. If an empty custom required field remains, confirm that the side panel identifies it for manual completion.

The previously inspected Workday tab is no longer open in the connected browser session, so this final live check remains pending; the generic behavior is covered by the JSDOM tests and the source/bundle regression checks.

## Working-tree note

Implementation was performed on `fix/generic-custom-widget-support` without creating a worktree. The checkout already contained unrelated uncommitted user changes, so no additional implementation commit was created that would bundle those changes together.
