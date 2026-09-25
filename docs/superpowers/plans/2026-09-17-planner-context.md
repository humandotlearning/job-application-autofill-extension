# Planner context implementation plan

**Goal:** Give the answer planner only relevant, scoped evidence and return complete validated extension decisions.

**Architecture:** Reuse retrieval at the LLM boundary. Keep existing decision IDs and schema so the worker and approval flow remain compatible. Preserve unrelated working changes.

**Tech stack:** JavaScript, Node test runner; no new dependencies.

1. Tighten `selectPlannerEvidence` in `src/retrieval.js`: use ranked matches without the narrative catch-all, retain name components, deduplicate equivalent answers per field, and exclude unrelated company motivation. Add regression coverage using synthetic examples.
2. In `src/llm.js`, associate evidence keys with each field, omit empty/repeated metadata and transport option values, and share one planner prompt across providers. Preserve constraints, entity scope, and human-visible options. Validate against the evidence supplied for each field.
3. Reserve output space for reasoning and actual answer text; reject provider truncation explicitly. Preserve strict provider JSON schema and reject contradictory non-fill output. Do not guess undocumented model-specific reasoning switches.
4. Run `node --test tests/llm.test.js tests/policy.test.js`, then `npm test`, `npm run check`, and `npm run build`. Record results and a compact example in documentation.

Completed all four steps. Full suite: 487 passing; syntax checks and build passed. Measured the supplied Phoenix request locally: 15 to 3 records, 85% fewer user-context characters. See `docs/planner-context.md` for behavior and limitations.
