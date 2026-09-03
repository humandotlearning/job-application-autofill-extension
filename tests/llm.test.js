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
        source: 'sheet',
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
  assert.deepEqual(
    body.input[1].content[0].input_json.page,
    { title: 'Senior Engineer Application', domain: 'jobs.example.com' },
  );
  assert.equal(JSON.stringify(body).includes('test-api-key'), false);
  assert.equal(JSON.stringify(body).includes('<form>secret</form>'), false);
  assert.equal(JSON.stringify(body).includes('<input>'), false);
  assert.equal(JSON.stringify(body).includes('https://jobs.example.com/apply?token=secret'), false);
});

test('rejects non-2xx responses', async () => {
  await assert.rejects(
    callAnswerPlanner(createInput(), {
      fetchImpl: async () => createResponse({ error: { message: 'bad request' } }, false, 400, 'Bad Request'),
    }),
    /400|Bad Request|bad request/i,
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
