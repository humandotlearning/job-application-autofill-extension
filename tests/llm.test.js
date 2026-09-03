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
  assert.equal(body.max_output_tokens <= 300, true);
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

test('rejects non-2xx responses', async () => {
  await assert.rejects(
    callAnswerPlanner(createInput(), {
      fetchImpl: async () => createResponse({ error: { message: 'bad request' } }, false, 400, 'Bad Request'),
    }),
    /400|Bad Request|bad request/i,
  );
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
