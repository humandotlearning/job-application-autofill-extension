# Answer planner context

The planner reuses saved facts. New prose belongs in the separate reviewed answer-drafting flow.

## Request

- Retrieve ranked evidence per field, with at most five records per field at the LLM boundary. Do not use the narrative catch-all pool for planning.
- Each field lists the evidence keys it may cite. Shared records appear once. Equivalent duplicate answers are collapsed; different questions and scopes remain distinct.
- Exclude transport-only questions, unrelated company motivation, and irrelevant saved answers. Accomplishment matching uses the saved question, so a phrase such as “impressive demos” in an unrelated answer does not qualify it.
- Omit empty metadata, repeated aliases/concepts, and option transport values. Preserve actual constraints, scope, current values, enabled option labels, and nonredundant explicit concepts.
- Answers longer than 8,000 characters are omitted rather than silently truncated into misleading evidence. Selection is heuristic and can miss useful evidence; explicit saved-answer search and reviewed drafting remain available.
- Page and saved text remain untrusted data. Filtering reduces irrelevant context; it is not a guarantee against every prompt-injection attempt.

## Response

The provider receives the strict `decisions` schema once. Existing extension field IDs, evidence keys, actions, confidence, sensitivity, reason, and transformations remain compatible.

The local validator checks field/evidence references and allowed transformations, and additionally rejects evidence not supplied for that field, contradictory non-fill decisions, and salary fills without compatible currency/period/scale. `keep` and `ask_user` require null value/transformation and empty evidence keys.

The completion budget starts at 4,096 tokens and accounts for copied answer length, capped at 12,000. A token-limit response retries once with a larger budget under the same 30-second deadline. Truncated responses are rejected even when their content parses as JSON. Reasoning text is never parsed as an answer or fed into the retry.

## Supplied Phoenix example

Reconstructed the request locally with a mocked provider; no paid model call or personal trace fixture was saved.

| Measure | Before | After |
| --- | ---: | ---: |
| Saved records | 15 | 3 |
| User context characters | 15,801 | 2,347 |
| Entire request characters | 19,639 | 4,693 |
| Initial completion budget | 640 | 4,096 |

Salary receives two salary records, but a unitless `60` cannot be accepted as a fill. The impressive-work question receives one accomplishment record. “Pick date...” still needs its actual question/format. A personal robotics belief requires user evidence; past company-interest answers cannot supply it.

Validation: `npm test` (488 passing), `npm run check`, `npm run build`. Live provider latency and answer quality still need checking on the next application run.
