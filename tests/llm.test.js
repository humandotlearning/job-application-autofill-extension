import test from 'node:test';
import assert from 'node:assert/strict';

import { callAnswerPlanner, callAnswerRewriter, callAnswerSuggestions, DEFAULT_FIREWORKS_MODEL, DEFAULT_PROVIDER } from '../src/llm.js';

function createInput() {
  return {
    apiKey: 'test-api-key',
    page: {
      title: 'Senior Engineer Application',
      domain: 'jobs.example.com',
      html: '<form>secret</form>',
      url: 'https://jobs.example.com/apply?token=secret',
    },
    fields: [
      {
        id: 'full_name',
        label: 'Full name',
        type: 'text',
        required: true,
        html: '<input>',
      },
      {
        id: 'portfolio',
        label: 'Portfolio URL',
        type: 'url',
        options: ['https://portfolio.example.com'],
      },
    ],
    records: [
      {
        key: 'candidate_name',
        question: 'What is your full name?',
        answer: 'Nithin',
        source: 'learned:https://jobs.example.com/apply?token=record-secret',
        html: '<p>Nithin</p>',
      },
      {
        key: 'portfolio_url',
        question: 'Portfolio',
        answer: 'https://portfolio.example.com',
        source: 'sheet',
      },
    ],
  };
}

function createResponse(payload, ok = true, status = 200, statusText = 'OK') {
  return {
    ok,
    status,
    statusText,
    json: async () => payload,
  };
}

test('planner copy cannot bypass compensation meaning facets', async () => {
  await assert.rejects(callAnswerPlanner({ apiKey: 'synthetic-key', fields: [{ id: 'pay', label: 'Expected salary', type: 'text' }], records: [{ key: 'current_salary', question: 'Current salary', answer: 'Synthetic explanation', sensitivity: 'review' }] }, {
    fetchImpl: async () => plannerResponse([{ fieldId: 'pay', action: 'fill', value: 'Synthetic explanation', evidenceKeys: ['current_salary'], confidence: 'high', sensitivity: 'review', reason: 'copy', transformation: 'copy' }]),
  }), /allowed transformation/);
});

test('rejects a non-ASCII API key before constructing a request header', async () => {
  let fetchCalls = 0;
  await assert.rejects(
    () => callAnswerPlanner({ ...createInput(), apiKey: 'test\u2011api-key' }, {
      fetchImpl: async () => {
        fetchCalls += 1;
        return createResponse({});
      },
    }),
    /ASCII|unsupported characters/i,
  );
  assert.equal(fetchCalls, 0);
});

test('sends one sanitized structured-output request and returns decisions', async () => {
  const calls = [];
  const input = createInput();

  const result = await callAnswerPlanner(input, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return createResponse({
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  decisions: [
                    {
                      fieldId: 'full_name',
                      action: 'fill',
                      value: 'Nithin',
                      evidenceKeys: ['candidate_name'],
                      confidence: 'high',
                      sensitivity: 'safe',
                      reason: 'Exact match',
                    },
                    {
                      fieldId: 'portfolio',
                      action: 'keep',
                      value: null,
                      evidenceKeys: [],
                      confidence: 'medium',
                      sensitivity: 'safe',
                      reason: 'Leave untouched',
                    },
                  ],
                }),
              },
            ],
          },
        ],
      });
    },
    timeoutMs: 4321,
  });

  assert.deepEqual(result, {
    decisions: [
      {
        fieldId: 'full_name',
        action: 'fill',
        value: 'Nithin',
        evidenceKeys: ['candidate_name'],
        confidence: 'high',
        sensitivity: 'safe',
        reason: 'Exact match',
      },
      {
        fieldId: 'portfolio',
        action: 'keep',
        value: null,
        evidenceKeys: [],
        confidence: 'medium',
        sensitivity: 'safe',
        reason: 'Leave untouched',
      },
    ],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.signal instanceof AbortSignal, true);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-api-key');

  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'gpt-5.6-terra');
  assert.equal(body.store, false);
  assert.ok(body.max_output_tokens >= 512);
  assert.equal(body.reasoning.effort, 'low');
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.schema.type, 'object');
  const plannerInput = JSON.parse(body.input[1].content[0].text);
  assert.deepEqual(plannerInput.page, { title: 'Senior Engineer Application', domain: 'jobs.example.com' });
  assert.equal(plannerInput.fields[0].autocomplete, '');
  assert.deepEqual(plannerInput.fields[0].constraints, {});
  assert.equal(JSON.stringify(body).includes('test-api-key'), false);
  assert.equal(JSON.stringify(body).includes('<form>secret</form>'), false);
  assert.equal(JSON.stringify(body).includes('<input>'), false);
  assert.equal(JSON.stringify(body).includes('https://jobs.example.com/apply?token=secret'), false);
  assert.equal(JSON.stringify(body).includes('record-secret'), false);
});

test('uses an explicitly configured model when provided', async () => {
  let requestBody;
  await callAnswerPlanner(createInput(), {
    model: 'gpt-luna-test',
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return plannerResponse([
        { fieldId: 'full_name', action: 'ask_user', value: null, evidenceKeys: [], confidence: 'low', sensitivity: 'safe', reason: 'Review' },
        { fieldId: 'portfolio', action: 'ask_user', value: null, evidenceKeys: [], confidence: 'low', sensitivity: 'safe', reason: 'Review' },
      ]);
    },
  });
  assert.equal(requestBody.model, 'gpt-luna-test');
});

test('uses Fireworks chat completions with the default provider and model', async () => {
  let request;
  const result = await callAnswerPlanner({ ...createInput(), apiKey: 'fireworks-test-key' }, {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return createResponse({ choices: [{ message: { content: JSON.stringify({ decisions: [
        { fieldId: 'full_name', action: 'ask_user', value: null, evidenceKeys: [], confidence: 'low', sensitivity: 'safe', reason: 'Review', transformation: null },
        { fieldId: 'portfolio', action: 'ask_user', value: null, evidenceKeys: [], confidence: 'low', sensitivity: 'safe', reason: 'Review', transformation: null },
      ] }) } }] });
    },
    provider: DEFAULT_PROVIDER,
  });

  assert.equal(DEFAULT_PROVIDER, 'fireworks');
  assert.equal(DEFAULT_FIREWORKS_MODEL, 'accounts/fireworks/models/glm-5p3-flash');
  assert.equal(request.url, 'https://api.fireworks.ai/inference/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, 'Bearer fireworks-test-key');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, DEFAULT_FIREWORKS_MODEL);
  assert.equal(body.max_tokens, 512);
  assert.equal(body.top_k, 40);
  assert.equal(body.response_format.type, 'json_schema');
  assert.deepEqual(body.response_format.json_schema.schema, body.response_format.json_schema.schema);
  assert.match(body.messages[0].content, /JSON schema/);
  assert.match(body.messages[0].content, /evidenceKeys/);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[1].role, 'user');
  assert.deepEqual(result.decisions.map(({ fieldId }) => fieldId), ['full_name', 'portfolio']);
});

test('Fireworks rewrite uses the shared strict schema and bounded token budget', async () => {
  let body;
  await callAnswerRewriter({ apiKey: 'test', question: 'Why?', draft: 'Because.' }, {
    provider: 'fireworks',
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return createResponse({ choices: [{ message: { content: JSON.stringify({ answer: 'Because.' }) } }] });
    },
  });
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.name, 'answer_rewriter');
  assert.deepEqual(body.response_format.json_schema.schema.required, ['answer']);
});

test('rejects non-2xx responses', async () => {
  await assert.rejects(
    callAnswerPlanner(createInput(), {
      fetchImpl: async () => createResponse({ error: { message: 'bad request' } }, false, 400, 'Bad Request'),
    }),
    /400|Bad Request|bad request/i,
  );
});

test('reports when the planner response is incomplete instead of hiding the token-limit cause', async () => {
  await assert.rejects(
    callAnswerPlanner(createInput(), {
      fetchImpl: async () => createResponse({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [],
      }),
    }),
    /incomplete|max_output_tokens|output tokens/i,
  );
});

test('budgets enough output tokens for every requested field decision', async () => {
  const fields = Array.from({ length: 12 }, (_, index) => ({
    id: `field_${index}`,
    label: `Field ${index}`,
    type: 'text',
  }));
  const decisions = fields.map((field) => ({
    fieldId: field.id,
    action: 'ask_user',
    value: null,
    evidenceKeys: [],
    confidence: 'low',
    sensitivity: 'safe',
    reason: 'No supported evidence',
  }));
  let requestBody;
  await callAnswerPlanner({ ...createInput(), fields }, {
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return plannerResponse(decisions);
    },
  });
  assert.ok(requestBody.max_output_tokens >= fields.length * 64);
});

test('surfaces refusals and network failures for deterministic fallback handling', async () => {
  await assert.rejects(
    callAnswerPlanner(createInput(), {
      fetchImpl: async () => createResponse({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'cannot comply' }] }] }),
    }),
    /missing structured output/i,
  );
  await assert.rejects(
    callAnswerPlanner(createInput(), { fetchImpl: async () => { throw new Error('network down'); } }),
    /network down/i,
  );
});

test('aborts a timed-out planner request', async () => {
  await assert.rejects(
    callAnswerPlanner(createInput(), {
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason || new Error('aborted')));
      }),
    }),
    /timed out|abort/i,
  );
});

test('rejects malformed structured output', async () => {
  await assert.rejects(
    callAnswerPlanner(createInput(), {
      fetchImpl: async () => createResponse({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: '{"decisions":"not-an-array"}' }],
          },
        ],
      }),
    }),
    /schema|decisions/i,
  );
});

test('rejects decisions that reference unknown field ids or evidence keys', async () => {
  await assert.rejects(
    callAnswerPlanner(createInput(), {
      fetchImpl: async () => createResponse({
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  decisions: [
                    {
                      fieldId: 'missing_field',
                      action: 'fill',
                      value: 'Nithin',
                      evidenceKeys: ['missing_record'],
                      confidence: 'high',
                      sensitivity: 'safe',
                      reason: 'Wrong references',
                    },
                  ],
                }),
              },
            ],
          },
        ],
      }),
    }),
    /field|evidence/i,
  );
});

test('rejects fill decisions without a value and evidence key', async () => {
  await assert.rejects(
    callAnswerPlanner(createInput(), {
      fetchImpl: async () => createResponse({
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  decisions: [
                    {
                      fieldId: 'full_name',
                      action: 'fill',
                      value: '   ',
                      evidenceKeys: [],
                      confidence: 'high',
                      sensitivity: 'safe',
                      reason: 'Incomplete',
                    },
                    {
                      fieldId: 'portfolio',
                      action: 'keep',
                      value: null,
                      evidenceKeys: [],
                      confidence: 'high',
                      sensitivity: 'safe',
                      reason: 'Leave unchanged',
                    },
                  ],
                }),
              },
            ],
          },
        ],
      }),
    }),
    /fill|value|evidence/i,
  );
});

function plannerResponse(decisions) {
  return createResponse({
    output: [{
      type: 'message',
      content: [{ type: 'output_text', text: JSON.stringify({ decisions }) }],
    }],
  });
}

test('rejects a different listed option even when both options are available', async () => {
  await assert.rejects(callAnswerPlanner({ apiKey: 'test', page: {},
    fields: [{ id: 'country', label: 'Country', type: 'select', options: ['India', 'United States'] }],
    records: [{ key: 'country', question: 'Country', answer: 'India', sensitivity: 'safe' }],
  }, { fetchImpl: async () => plannerResponse([{ ...validDecision('country', 'United States', 'fill'), evidenceKeys: ['country'] }]) }), /evidence/i);
});

test('does not change email punctuation while claiming to copy evidence', async () => {
  await assert.rejects(callAnswerPlanner({ apiKey: 'test', page: {},
    fields: [{ id: 'email', label: 'Email', type: 'email' }],
    records: [{ key: 'email', answer: 'ada+jobs@example.com', sensitivity: 'safe' }],
  }, { fetchImpl: async () => plannerResponse([{ ...validDecision('email', 'ada-jobs@example.com', 'fill'), evidenceKeys: ['email'], transformation: 'copy' }]) }), /evidence/i);
});

test('rejects evidence from a different name concept or employment entity', async () => {
  for (const [field, record] of [
    [{ id: 'first_name', label: 'First name', type: 'text' }, { key: 'last_name', answer: 'Smith', question: 'Last name' }],
    [{ id: 'company', label: 'Company', entityId: 'job2', type: 'text' }, { key: 'company', answer: 'Smith', question: 'Company', entityId: 'job1' }],
  ]) {
    await assert.rejects(callAnswerPlanner({ apiKey: 'test', fields: [field], records: [record], page: {} }, {
      fetchImpl: async () => plannerResponse([{ ...validDecision(field.id, 'Smith', 'fill'), evidenceKeys: [record.key] }]),
    }), /evidence/i);
  }
});

test('rejects ambiguous source dates and impossible calendar dates', async () => {
  for (const answer of ['01/02/1990', '1990-02-30']) {
    await assert.rejects(callAnswerPlanner({ apiKey: 'test', page: {},
      fields: [{ id: 'dob', label: 'Date of birth', type: 'date' }],
      records: [{ key: 'dob', question: 'Date of birth', answer, sensitivity: 'safe' }],
    }, { fetchImpl: async () => plannerResponse([{ ...validDecision('dob', answer === '01/02/1990' ? '1990-01-02' : '02/30/1990', 'fill'), evidenceKeys: ['dob'], sensitivity: 'review' }]) }), /evidence/i);
  }
});

function validDecision(fieldId, value = null, action = 'keep') {
  return {
    fieldId,
    action,
    value,
    evidenceKeys: action === 'fill' ? ['candidate_name'] : [],
    confidence: 'high',
    sensitivity: 'safe',
    reason: action === 'fill' ? 'Evidence-backed value' : 'Leave unchanged',
  };
}

test('accepts evidence-backed name composition and date formatting transformations', async () => {
  const fields = [
    { id: 'full_name', label: 'Full name', type: 'text' },
    { id: 'dob', label: 'Date of birth', type: 'text', placeholder: 'MM/DD/YYYY' },
  ];
  const records = [
    { key: 'first_name', question: 'First name', answer: 'Ada', sensitivity: 'safe' },
    { key: 'last_name', question: 'Last name', answer: 'Lovelace', sensitivity: 'safe' },
    { key: 'date_of_birth', question: 'Date of birth', answer: '1990-01-02', sensitivity: 'safe' },
  ];
  const result = await callAnswerPlanner({ apiKey: 'test-api-key', fields, records, page: {} }, {
    fetchImpl: async () => plannerResponse([
      { fieldId: 'full_name', action: 'fill', value: 'Ada Lovelace', evidenceKeys: ['first_name', 'last_name'], confidence: 'high', sensitivity: 'safe', reason: 'Compose first and last name' },
      { fieldId: 'dob', action: 'fill', value: '01/02/1990', evidenceKeys: ['date_of_birth'], confidence: 'high', sensitivity: 'review', transformation: 'format_date', reason: 'Reformat the stored date' },
    ]),
  });
  assert.equal(result.decisions.length, 2);
});

test('accepts a canonical option label when the stored answer uses a common abbreviation', async () => {
  const result = await callAnswerPlanner({
    apiKey: 'test-api-key',
    fields: [{ id: 'country', label: 'Country', type: 'select', options: ['United States'] }],
    records: [{ key: 'country', question: 'Country', answer: 'US', sensitivity: 'safe' }],
    page: {},
  }, {
    fetchImpl: async () => plannerResponse([{
      fieldId: 'country', action: 'fill', value: 'United States', evidenceKeys: ['country'], confidence: 'high', sensitivity: 'safe', reason: 'Canonical option label',
    }]),
  });
  assert.equal(result.decisions[0].value, 'United States');
});

test('accepts a reviewed semantic option mapping only as a visible label', async () => {
  const result = await callAnswerPlanner({
    apiKey: 'test-api-key',
    fields: [{ id: 'heard', label: 'How did you hear about us?', type: 'select', options: ['Recruiter', 'Company website'] }],
    records: [{ key: 'how_did_you_hear_about_this_job', question: 'How did you hear about this job?', answer: 'My Hermes agent found the role relevant to my profile', sensitivity: 'safe' }],
    page: {},
  }, {
    fetchImpl: async () => plannerResponse([{
      fieldId: 'heard', action: 'fill', value: 'Recruiter', evidenceKeys: ['how_did_you_hear_about_this_job'], confidence: 'medium', sensitivity: 'safe', transformation: 'map_option', reason: 'Visible option selected for review',
    }]),
  });
  assert.equal(result.decisions[0].value, 'Recruiter');
  assert.equal(result.decisions[0].transformation, 'map_option');
});

test('rejects opaque option values from planner output', async () => {
  await assert.rejects(callAnswerPlanner({
    apiKey: 'test-api-key',
    fields: [{ id: 'heard', label: 'How did you hear about us?', type: 'select', options: ['Recruiter', '4466d54cbeba1000aec278b38cc80000'] }],
    records: [{ key: 'how_did_you_hear_about_this_job', question: 'How did you hear about this job?', answer: 'Recruiter', sensitivity: 'safe' }],
    page: {},
  }, {
    fetchImpl: async () => plannerResponse([{
      fieldId: 'heard', action: 'fill', value: '4466d54cbeba1000aec278b38cc80000', evidenceKeys: ['how_did_you_hear_about_this_job'], confidence: 'high', sensitivity: 'safe', transformation: 'map_option', reason: 'Internal option value',
    }]),
  }), /opaque|evidence|option/i);
});

test('planner payload treats option values as transport data and instructs label-only mapping', async () => {
  let requestBody;
  await callAnswerPlanner({
    apiKey: 'test-api-key',
    fields: [{ id: 'heard', label: 'How did you hear about us?', type: 'select', structuredOptions: [{ label: 'Recruiter', value: '4466d54cbeba1000aec278b38cc80000' }] }],
    records: [],
    page: {},
  }, {
    fetchImpl: async (_url, options) => { requestBody = JSON.parse(options.body); return plannerResponse([{ fieldId: 'heard', action: 'ask_user', value: null, evidenceKeys: [], confidence: 'low', sensitivity: 'safe', reason: 'Needs review' }]); },
  });
  const body = JSON.stringify(requestBody);
  assert.doesNotMatch(body, /4466d54cbeba1000aec278b38cc80000/);
  assert.match(requestBody.input[0].content[0].text, /human-readable|internal|option label/i);
});

test('map_option requires an exact visible label on a choice field', async () => {
  await assert.rejects(callAnswerPlanner({
    apiKey: 'test-api-key',
    fields: [{ id: 'country', label: 'Country', type: 'select', options: ['United States'] }],
    records: [{ key: 'country', question: 'Country', answer: 'US', sensitivity: 'safe' }],
    page: {},
  }, {
    fetchImpl: async () => plannerResponse([{ fieldId: 'country', action: 'fill', value: 'US', evidenceKeys: ['country'], confidence: 'high', sensitivity: 'safe', transformation: 'map_option', reason: 'Abbreviation' }]),
  }), /evidence|transformation/i);
  await assert.rejects(callAnswerPlanner({
    apiKey: 'test-api-key',
    fields: [{ id: 'country', label: 'Country', type: 'text', options: ['United States'] }],
    records: [{ key: 'country', question: 'Country', answer: 'United States', sensitivity: 'safe' }],
    page: {},
  }, {
    fetchImpl: async () => plannerResponse([{ fieldId: 'country', action: 'fill', value: 'United States', evidenceKeys: ['country'], confidence: 'high', sensitivity: 'safe', transformation: 'map_option', reason: 'Not a choice control' }]),
  }), /evidence|transformation/i);
});

test('keeps valid planner decisions when another decision fails validation', async () => {
  const result = await callAnswerPlanner(createInput(), {
    allowPartial: true,
    fetchImpl: async () => plannerResponse([
      { fieldId: 'full_name', action: 'fill', value: 'Invented', evidenceKeys: ['candidate_name'], confidence: 'high', sensitivity: 'safe', reason: 'Invalid evidence transformation' },
      { fieldId: 'portfolio', action: 'keep', value: null, evidenceKeys: [], confidence: 'high', sensitivity: 'safe', reason: 'Leave unchanged' },
    ]),
  });
  assert.deepEqual(result.decisions.map((decision) => decision.fieldId), ['portfolio']);
});

test('rejects duplicate decisions for the same field', async () => {
  await assert.rejects(
    callAnswerPlanner(createInput(), {
      fetchImpl: async () => plannerResponse([
        validDecision('full_name', 'Nithin', 'fill'),
        validDecision('full_name', 'Nithin', 'fill'),
      ]),
    }),
    /duplicate|one decision|field/i,
  );
});

test('rejects responses that omit a supplied field', async () => {
  await assert.rejects(
    callAnswerPlanner(createInput(), {
      fetchImpl: async () => plannerResponse([validDecision('full_name', 'Nithin', 'fill')]),
    }),
    /missing|every field|one decision|field/i,
  );
});

test('rejects a safe proposal for a review-sensitive field', async () => {
  await assert.rejects(
    callAnswerPlanner({
      apiKey: 'test-api-key',
      page: { title: 'Application', domain: 'jobs.example.com' },
      fields: [{ id: 'salary', label: 'Expected CTC', type: 'number', required: true }],
      records: [{ key: 'expected_ctc', question: 'Expected CTC', answer: '5000000', sensitivity: 'review' }],
    }, {
      fetchImpl: async () => plannerResponse([{
        fieldId: 'salary',
        action: 'fill',
        value: '5000000',
        evidenceKeys: ['expected_ctc'],
        confidence: 'high',
        sensitivity: 'safe',
        reason: 'Evidence-backed value',
      }]),
    }),
    /sensitive|safe/i,
  );
});

test('rejects an invented value even when the evidence key exists', async () => {
  await assert.rejects(
    callAnswerPlanner({
      apiKey: 'test-api-key',
      page: { title: 'Application', domain: 'jobs.example.com' },
      fields: [{ id: 'name', label: 'Full name', type: 'text' }],
      records: [{ key: 'candidate_name', question: 'Candidate name', answer: 'Nithin', sensitivity: 'safe' }],
    }, {
      fetchImpl: async () => plannerResponse([{
        fieldId: 'name', action: 'fill', value: 'Invented Person', evidenceKeys: ['candidate_name'], confidence: 'high', sensitivity: 'safe', reason: 'Unrelated value',
      }]),
    }),
    /evidence|transformation/i,
  );
});

function rewriteResponse(answer) {
  return createResponse({
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ answer }) }] }],
  });
}

test('suggestion and rewrite prompts quarantine opaque records and answers', async () => {
  const opaque = '4466d54cbeba1000aec278b38cc80000';
  let suggestionBody;
  await callAnswerSuggestions({
    apiKey: 'test',
    field: { id: 'summary', label: 'Summary', type: 'textarea' },
    records: [{ key: 'opaque', question: 'Opaque', answer: opaque }, { key: 'readable', question: 'Summary', answer: 'Readable evidence' }],
  }, {
    fetchImpl: async (_url, options) => {
      suggestionBody = JSON.parse(options.body);
      return createResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ suggestions: [], missingContext: '' }) }] }] });
    },
  });
  assert.doesNotMatch(JSON.stringify(suggestionBody), new RegExp(opaque));
  await assert.rejects(callAnswerSuggestions({ apiKey: 'test', field: { id: 'summary', label: 'Summary', type: 'textarea' } }, {
    fetchImpl: async () => createResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ suggestions: [{ answer: opaque, evidenceKeys: [] }], missingContext: '' }) }] }] }),
  }), /Invalid suggestion/);

  let rewriteBody;
  await callAnswerRewriter({ apiKey: 'test', question: 'Summary', draft: 'Readable draft', records: [{ key: 'opaque', question: 'Opaque', answer: opaque }] }, {
    fetchImpl: async (_url, options) => { rewriteBody = JSON.parse(options.body); return rewriteResponse('Readable rewrite'); },
  });
  assert.doesNotMatch(JSON.stringify(rewriteBody), new RegExp(opaque));
  await assert.rejects(callAnswerRewriter({ apiKey: 'test', question: 'Summary', draft: 'Readable draft' }, {
    fetchImpl: async () => rewriteResponse(opaque),
  }), /non-empty/);
});

test('rewriter sends bounded structured data using the configured model', async () => {
  let request;
  const result = await callAnswerRewriter({
    apiKey: 'rewrite-key',
    question: 'Why do you want this role?',
    draft: 'I enjoy solving difficult problems.',
    instruction: 'Make it more concise',
    records: [{ key: 'motivation', question: 'Motivation', answer: 'I enjoy solving difficult problems.', sensitivity: 'safe' }],
  }, {
    model: 'gpt-rewrite-test',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return rewriteResponse('I enjoy solving challenging problems.');
    },
  });
  assert.deepEqual(result, { answer: 'I enjoy solving challenging problems.' });
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, 'gpt-rewrite-test');
  assert.equal(body.store, false);
  assert.equal(body.text.format.strict, true);
  const input = JSON.parse(body.input[1].content[0].text);
  assert.equal(input.question, 'Why do you want this role?');
  assert.equal(input.draft, 'I enjoy solving difficult problems.');
  assert.equal(input.instruction, 'Make it more concise');
  assert.equal(input.records[0].answer, 'I enjoy solving difficult problems.');
  assert.equal(JSON.stringify(body).includes('rewrite-key'), false);
});

test('rewriter rejects malformed, empty, and non-OK responses', async () => {
  await assert.rejects(callAnswerRewriter({ apiKey: 'test', question: 'Q', draft: 'D', instruction: 'I' }, {
    fetchImpl: async () => createResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{bad' }] }] }),
  }), /Answer rewrite.*invalid structured JSON/i);
  await assert.rejects(callAnswerRewriter({ apiKey: 'test', question: 'Q', draft: 'D', instruction: 'I' }, {
    fetchImpl: async () => rewriteResponse('   '),
  }), /Answer rewrite.*non-empty/i);
  await assert.rejects(callAnswerRewriter({ apiKey: 'test', question: 'Q', draft: 'D', instruction: 'I' }, {
    fetchImpl: async () => createResponse({ error: { message: 'bad request' } }, false, 422, 'Unprocessable Entity'),
  }), /Answer rewrite.*422.*bad request/i);
});

test('rewriter aborts timed-out requests and bounds prompt data', async () => {
  await assert.rejects(callAnswerRewriter({ apiKey: 'test', question: 'Q', draft: 'D', instruction: 'I' }, {
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
  }), /Answer rewrite.*timed out|abort/i);
  let requestBody;
  await callAnswerRewriter({ apiKey: 'test', question: 'q'.repeat(10000), draft: 'd'.repeat(10000), instruction: 'i'.repeat(10000), records: Array.from({ length: 50 }, (_, i) => ({ key: `k${i}`, question: 'r'.repeat(5000), answer: 'a'.repeat(5000) })) }, {
    fetchImpl: async (_url, options) => { requestBody = JSON.parse(options.body); return rewriteResponse('ok'); },
  });
  const input = JSON.parse(requestBody.input[1].content[0].text);
  assert.ok(input.question.length < 10000);
  assert.ok(input.draft.length < 10000);
  assert.ok(input.instruction.length < 10000);
  assert.ok(input.records.length < 50);
  assert.ok(input.records.every((record) => record.question.length < 5000 && record.answer.length < 5000));
});
