# Task 3 Report: Bounded answer rewrite model call

## Status

Complete.

## Changes

- Added `callAnswerRewriter` to `src/llm.js`.
- Reused API-key normalization, Responses endpoint, timeout/abort handling, error-detail handling, and structured-output extraction.
- Added strict `{ answer }` JSON schema and non-empty answer validation.
- Added bounded sanitization for question, draft, instruction, and evidence records.
- Ensured request bodies use `store: false` and never include the API key.
- Added focused tests for request shape, model selection, malformed/empty output, HTTP errors, timeout, and input bounds.

## Verification

Command: `npm test -- tests/llm.test.js`

Result: 26 tests passed, 0 failed.

## Concerns

- Rewriting is intentionally limited to the supplied draft and evidence; worker-side authorization and form-application safeguards remain the responsibility of the calling flow.
