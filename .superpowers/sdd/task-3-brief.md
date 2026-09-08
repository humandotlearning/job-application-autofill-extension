### 3. Add the bounded rewrite model call

**Files:** `tests/llm.test.js`, `src/llm.js`.

1. Add a failing test for `callAnswerRewriter` that stubs `fetch`, captures the request, returns strict structured output `{ answer: "..." }`, and asserts the request uses the configured model, `store:false`, the question/draft/instruction/evidence payload, and the existing Responses endpoint.
2. Add failing tests for malformed structured output, missing/empty answer, non-OK responses, timeout, and prompt/data length bounds. Verify user-provided strings are serialized as data and no API key is returned in the result.
3. Implement `REWRITE_SCHEMA`, bounded output-token settings, request sanitizers for question/draft/instruction/evidence, and exported `callAnswerRewriter({ apiKey, question, draft, instruction, records }, { model, fetchImpl, timeoutMs })` using the same API-key normalization and structured-output extraction as the planner.
4. Validate that the result is one non-empty string answer and surface actionable `Answer rewrite ...` errors consistent with planner errors. Do not write to Chrome storage from this module.
5. Run `npm test -- tests/llm.test.js` and commit as `feat: add bounded answer rewrite call`.
