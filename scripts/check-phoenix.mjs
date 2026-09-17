import assert from 'node:assert/strict';
import {createPhoenixFetch} from '../src/phoenix.js';

const providerUrl = 'https://api.fireworks.ai/inference/v1/chat/completions';
const session = `setup-${Date.now()}`;
let exportedId;
const traced = createPhoenixFetch(session, {
  enabled: async () => true,
  fetchImpl: async (url, options) => {
    if (url === providerUrl) return Response.json({choices: [{message: {role: 'assistant', content: 'Phoenix captured this synthetic response.'}}], usage: {prompt_tokens: 8, completion_tokens: 7, total_tokens: 15}});
    exportedId = JSON.parse(options.body).data[0].context.span_id;
    return fetch(url, {...options, headers: {...options.headers, Origin: 'chrome-extension://phoenix-setup-check'}});
  },
});
await traced(providerUrl, {
  method: 'POST', headers: {Authorization: 'Bearer synthetic-never-export'},
  body: JSON.stringify({model: 'synthetic-no-paid-call', messages: [{role: 'user', content: 'Verify local tracing.'}], response_format: {json_schema: {name: 'phoenix_setup_check'}}}),
});
let found;
for (let attempt = 0; attempt < 15; attempt++) {
  const response = await fetch('http://127.0.0.1:6006/v1/projects/job-autofill/spans');
  if (response.ok) found = (await response.json()).data.find(span => span.context.span_id === exportedId);
  if (found) break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert.ok(found, 'Trace should be readable from Phoenix');
const attrs = found.attributes;
const input = attrs['input.value'] ?? attrs.input?.value;
const output = attrs['output.value'] ?? attrs.output?.value;
assert.equal(JSON.parse(input).messages[0].content, 'Verify local tracing.');
assert.equal(JSON.parse(output).choices[0].message.content, 'Phoenix captured this synthetic response.');
assert.equal(JSON.stringify(found).includes('synthetic-never-export'), false);
console.log(`Verified Phoenix input/output round-trip: ${found.context.trace_id}`);
