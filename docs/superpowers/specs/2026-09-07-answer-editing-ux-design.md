# Answer Editing UX Design

## Context

The side panel currently explains unresolved questions and displays saved evidence, but it does not make the exact answer that will be sent to the application form sufficiently visible or editable. A user must be able to choose an answer, review it, edit it, optionally ask the configured AI model to rewrite it, and explicitly send the final text to the form.

## Goals

- Make the proposed answer for each question visible before it is applied.
- Keep the answer blank until the user explicitly chooses a candidate when candidates are available.
- Support direct editing in a normal text area.
- Support an optional natural-language rewrite prompt using the extension's configured AI model and API key.
- Require an explicit user action to apply the final draft to the page.
- Preserve existing validation, safe-autofill rules, evidence provenance, approval checks, and manual submission behavior.

## Non-goals

- No changes to saved-answer storage or datasource schema.
- No automatic candidate selection or automatic form mutation.
- No automatic submission of the application site.
- No new global search or chat surface.
- No ability to apply opaque internal IDs as answers.

## Interaction design

Every named question remains the visual anchor of its item. Under the question:

1. An answer workspace shows an empty text area and a clear state such as “Choose a saved answer or write one.”
2. Each readable candidate is shown as nested evidence with a **Choose this answer** control. Choosing a candidate copies its verbatim answer into the workspace and marks it as the current draft; it does not change the page.
3. The draft has an **Edit** control. Edit mode uses a normal textarea with the complete draft text and an **Use edited answer**/save control. The user can revise it freely.
4. An **Ask AI to rewrite** control opens a short prompt input. Submitting the prompt sends the current question, current draft, relevant evidence, and rewrite instruction to the existing configured model. The returned text replaces the draft only; it is not applied to the page automatically. The user can edit or discard it.
5. A prominent **Send to form** control applies the exact current draft through the existing approval/fill message and then re-inspects and validates the field. The control is disabled until a readable draft exists. Existing stale-origin, field-handle, and safety checks remain authoritative.

When no candidate exists, the workspace remains empty so the user can type an answer manually. When a candidate answer is opaque, it stays behind the existing Internal ID disclosure and has no choose/apply control. Human-readable evidence keeps its provenance and remains usable.

## Data flow and boundaries

The panel owns only transient draft state keyed by the run, page, and field identity. Candidate selection, manual edits, and AI rewrite results remain in memory until **Send to form**. The worker validates the field and current page/frame origin before applying the draft, using the same guarded path as existing approvals. A rewrite request is presentation assistance only; it cannot bypass evidence, sensitivity, option, or validation rules. Failed rewrite or apply requests leave the current draft intact and show an actionable error.

## Accessibility and responsive behavior

- Textareas, candidate buttons, rewrite prompt, and apply controls have question-specific accessible labels.
- Candidate selection and apply status are announced through existing status messaging.
- The rewrite prompt is keyboard reachable and dismissible without losing the draft.
- Internal IDs remain disclosed only through the existing keyboard/touch-compatible info control.
- Long answers remain readable with the existing expandable answer treatment; the editable textarea can scroll vertically.

## Verification

- Candidate answers do not populate a draft until the user chooses one.
- The selected answer appears verbatim in the editable textarea.
- Manual edits are the exact payload sent by **Send to form**.
- Rewrite prompts use the configured model and replace only the transient draft.
- Rewrite/apply failures preserve the draft and expose a clear error.
- Opaque candidates cannot be selected or applied.
- Existing evidence approval, validation, page ordering, and manual submission tests continue to pass.
