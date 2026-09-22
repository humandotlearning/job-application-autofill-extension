import test from 'node:test';
import assert from 'node:assert/strict';
import { callAnswerPlanner } from '../src/llm.js';

const ask = field => ({fieldId: field.id, action: 'ask_user', value: null, evidenceKeys: [], confidence: 'low', sensitivity: 'safe', reason: 'Missing context', transformation: null});
const response = decisions => ({ok: true, json: async () => ({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({decisions})}}]})});
const records = [
  {key: 'desired_salary', question: 'Desired Salary', answer: '60', sensitivity: 'review'},
  {key: 'expected_ctc', question: 'Expected CTC', answer: '40-60 LPA', sensitivity: 'review'},
  {key: 'achievements', question: 'Projects or accomplishments you are most proud of', answer: 'Built camera analytics at production scale.', sensitivity: 'safe'},
  {key: 'duplicate', question: 'Projects or accomplishments you are most proud of', answer: 'Built camera analytics at production scale.', sensitivity: 'safe'},
  {key: 'company', question: 'What interests you about Another Company?', answer: 'I built machine learning systems and want to join Another Company.', sensitivity: 'safe'},
  {key: 'english', question: 'Professional English fluency', answer: 'Fluent', sensitivity: 'safe'},
];
const fields = [
  {id: 'salary', label: 'What is your expected salary?', type: 'number', required: true},
  {id: 'date', label: 'Pick date...', placeholder: 'Pick date...', type: 'text', required: true},
  {id: 'achievement', label: 'Provide an example of something impressive you have built', type: 'textarea', required: true},
  {id: 'belief', label: 'What uncommon belief do you hold about robotics?', type: 'textarea', required: true},
];

test('planner isolates evidence, removes empty metadata and duplicate/unrelated answers on both providers', async () => {
  const inputs = [];
  for (const provider of ['openai', 'fireworks']) {
    await callAnswerPlanner({apiKey: 'test', fields, records}, {provider, fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      inputs.push(JSON.parse(provider === 'fireworks' ? body.messages[1].content : body.input[1].content[0].text));
      return response(fields.map(ask));
    }});
  }
  assert.deepEqual(inputs[0], inputs[1]);
  const context = inputs[0];
  assert.deepEqual(context.fields[1].evidenceKeys, []);
  assert.deepEqual(context.fields[3].evidenceKeys, []);
  assert.equal(context.fields[2].evidenceKeys.length, 1);
  assert.ok(context.fields[2].evidenceKeys.includes('achievements'));
  assert.ok(!JSON.stringify(context).includes('Another Company'));
  assert.ok(!JSON.stringify(context).includes('Fluent'));
  assert.ok(context.records.every(record => !('aliases' in record) && !('concept' in record)));
});

test('planner supplies enabled display labels and preserves real constraints', async () => {
  const field = {id: 'choice', label: 'Country', type: 'select', constraints: {maxLength: 40}, structuredOptions: [
    {label: 'India', value: 'transport-value'}, {label: 'Disabled option', value: 'disabled', disabled: true},
  ]};
  await callAnswerPlanner({apiKey: 'test', fields: [field]}, {fetchImpl: async (_url, options) => {
    const input = JSON.parse(JSON.parse(options.body).input[1].content[0].text);
    assert.deepEqual(input.fields[0].options, ['India']);
    assert.deepEqual(input.fields[0].constraints, {maxLength: 40});
    assert.doesNotMatch(JSON.stringify(input), /transport-value|Disabled option|structuredOptions/);
    return response([ask(field)]);
  }});
});

test('Fireworks length termination is rejected even with parseable partial output', async () => {
  for (const content of ['', JSON.stringify({decisions: fields.map(ask)})]) {
    await assert.rejects(callAnswerPlanner({apiKey: 'test', fields, records}, {provider: 'fireworks', allowPartial: true,
      fetchImpl: async () => ({ok: true, json: async () => ({choices: [{finish_reason: 'length', message: {content, reasoning_content: 'reasoning only'}}]})}),
    }), /incomplete.*max_tokens/);
  }
});

test('non-fill output cannot carry a value or transformation', async () => {
  await assert.rejects(callAnswerPlanner({apiKey: 'test', fields: [fields[0]], records}, {
    fetchImpl: async () => response([{...ask(fields[0]), value: '60', transformation: 'copy'}]),
  }), /non-fill/);
});

test('unitless salary cannot become a fill even if copied from a saved answer', async () => {
  await assert.rejects(callAnswerPlanner({apiKey: 'test', fields: [fields[0]], records}, {
    fetchImpl: async () => response([{...ask(fields[0]), action: 'fill', value: '60', evidenceKeys: ['desired_salary'], sensitivity: 'review', transformation: 'copy'}]),
  }), /salary.*units/);
});

test('planner retries truncation once with more room and no reasoning carried forward', async () => {
  const requests = [];
  const result = await callAnswerPlanner({apiKey: 'test', fields, records}, {provider: 'fireworks', fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (requests.length === 1) return {ok: true, json: async () => ({choices: [{finish_reason: 'length', message: {content: '', reasoning_content: 'private reasoning'}}]})};
    return response(fields.map(ask));
  }});
  assert.equal(requests.length, 2);
  assert.equal(requests[1].max_tokens, requests[0].max_tokens * 2);
  assert.deepEqual(requests[0].messages, requests[1].messages);
  assert.doesNotMatch(JSON.stringify(requests), /private reasoning/);
  assert.equal(result.decisions.length, 4);
});

test('planner rejects evidence for another field even if the value is a literal saved answer', async () => {
  const inputFields = [{id: 'experience', label: 'Describe machine learning experience', type: 'textarea'}, fields[3]];
  const inputRecords = [{key: 'ml', question: 'Machine learning experience', answer: 'Built machine learning systems for industrial monitoring.', sensitivity: 'safe'}];
  await assert.rejects(callAnswerPlanner({apiKey: 'test', fields: inputFields, records: inputRecords}, {
    fetchImpl: async () => response([ask(inputFields[0]), {...ask(fields[3]), action: 'fill', value: inputRecords[0].answer, evidenceKeys: ['ml'], transformation: 'copy'}]),
  }), /evidence not supplied/);
});

test('planner reports rejected partial decisions instead of silently succeeding', async () => {
  const field = {id: 'country', label: 'Country', type: 'select', widget: 'custom', options: [], optionsStatus: 'unavailable'};
  const result = await callAnswerPlanner({apiKey: 'test', fields: [field], records: [{key: 'country', question: 'Country', answer: 'India', sensitivity: 'safe'}]}, {
    allowPartial: true,
    fetchImpl: async () => response([{fieldId: 'country', action: 'fill', value: 'India', evidenceKeys: ['country'], confidence: 'high', sensitivity: 'safe', reason: 'Country record', transformation: 'map_option'}]),
  });
  assert.deepEqual(result.decisions, []);
  assert.match(result.rejectedDecisions[0].reason, /allowed transformation/);
});
