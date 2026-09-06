import test from 'node:test';
import assert from 'node:assert/strict';

import { callAnswerPlanner } from '../src/llm.js';

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
