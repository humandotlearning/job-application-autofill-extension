# Action Required UX Design

## Goal

Make a required-field pause tell the applicant exactly what to do, and never
show an opaque stored identifier as an answer they can approve.

## Behaviour

For the Phone Device Type example, the panel will tell the applicant to choose
a phone type on the application page, use **Show on page**, and then select
**Check again**. A generic unsupported-widget notice remains visible only when
it is the only blocker; it does not compete with the named field's instruction.

Reusable-answer candidates are classified before rendering. Human-readable
values remain eligible for **Use this saved answer** or **Edit and use**. An
opaque identifier (a long hexadecimal token with no readable words) is not
rendered as an answer and has no approval buttons. Instead, the panel explains
that the prior saved value cannot be used and that the applicant should choose
the value on the application page.

## Scope and Error Handling

This changes side-panel presentation only. It does not change how answers are
captured, stored, validated, or applied. Existing approval safety checks remain
unchanged. The detector is deliberately conservative: normal short codes and
readable values continue to display; only long all-hex values are hidden.

## Tests

Add a panel regression test with a required select and an opaque candidate. It
must show the named next-step instruction, hide the token, and omit approval
buttons. Existing evidence-rendering coverage protects readable candidates.
