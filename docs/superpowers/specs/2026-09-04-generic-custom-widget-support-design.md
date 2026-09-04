# Generic Custom Form Widget Support

## Goal

Allow the autofill extension to recognize and safely operate common custom form controls on Workday and unfamiliar job sites, while avoiding false pauses caused by utility menus such as language and settings controls.

## Scope

The change covers visible custom single-value choice controls that expose an accessible button/combobox/listbox contract or a button paired with a form-associated input. It preserves the existing support for native inputs, textareas, radios, checkboxes, and selects.

Shadow-root controls, cross-origin iframe controls, CAPTCHA, login, file uploads, ambiguous widgets, and controls without a safe option match remain manual pause points.

## Design

### Field discovery

The form engine will produce descriptors for field-like custom choice controls in addition to native form elements. Discovery will be accessibility- and structure-driven rather than based on Workday IDs, CSS class names, page order, or coordinates.

Candidate controls must be visible and satisfy a field-like contract, such as:

- a visible `role="combobox"` or `aria-haspopup="listbox"` control associated with a form field;
- a button paired with a sibling or nearby form-associated input; or
- a native select, which continues to use the existing path.

Utility menus outside the form/main content area are excluded. Duplicate controls for the same field are collapsed into one descriptor.

Each custom descriptor includes a stable field ID, accessible label, current displayed value, required state when available, and any options that are already rendered. The descriptor records that its interaction strategy is custom so application logic can select it without treating it as a native select.

### Safe matching and interaction

Known local answers are matched against the custom field label using the existing deterministic matcher. A custom control with a non-empty displayed value is treated as complete and is not blocked merely because it is implemented with ARIA.

When a safe answer exists, the content script will:

1. open the custom control through its DOM click action;
2. inspect the visible listbox/options rendered by the page;
3. select only an exact normalized match against an option label or value;
4. dispatch the normal input/change events where supported; and
5. rescan and validate the resulting displayed value.

Partial, ambiguous, unavailable, or invalid matches are not selected automatically. They produce a manual unresolved item instead.

### Pause behavior

The extension will no longer pause for every visible listbox-like element. It pauses only for a field-like custom control that is unresolved, invalid, or unsupported after discovery. Already-selected custom values and unrelated utility menus do not create `unsupported_widget` blockers.

The side panel continues to show the field label and reason, and the user can complete it manually before selecting **Continue**.

### Data flow and submission

The existing run lifecycle remains unchanged:

1. inspect the current page;
2. deterministically fill validated local answers;
3. use the answer planner only for remaining unresolved fields when configured;
4. rescan and validate;
5. capture non-empty supported values before moving to the next page;
6. require explicit final confirmation;
7. capture and persist final answers; and
8. submit exactly once.

Custom-widget values therefore learn through the same final-confirmation path as native field values.

## Error handling and safety

- If a widget cannot be identified as a field, it is ignored as a utility control rather than clicked.
- If a field-like widget cannot be opened, its options cannot be read, or its option match is not exact, the run pauses for manual completion.
- No coordinate clicks, guessed selectors, page-order assumptions, or invented values are introduced.
- Existing manual boundaries remain in force for passwords, hidden fields, files, CAPTCHA, login, cross-origin frames, shadow roots, and ambiguous navigation.

## Testing

Add regression coverage for:

- already-selected custom listbox controls not blocking a run;
- utility listbox controls being ignored;
- exact matching and selection of a generic custom option;
- unresolved or ambiguous custom options pausing safely;
- Workday-like button-plus-hidden-input structure; and
- preservation of the existing native control and final submission behavior.

The tests will use generic fixtures for the core behavior and a small Workday-like fixture only to verify the observed structural pattern, without depending on Workday-specific IDs or CSS classes.

## Non-goals

- Supporting every proprietary widget implementation;
- bypassing CAPTCHA, login, uploads, or browser security boundaries;
- automatically choosing approximate options; or
- changing the explicit final submission confirmation requirement.
