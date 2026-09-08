import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as llm from '../src/llm.js';
import { inspectDocument } from '../src/form-engine.js';

test('inspection carries job context and question help without unrelated controls', () => {
  const { window } = new JSDOM(`<title>Apply</title><main><h1>Platform Engineer</h1><div class="job-description">Build reliable distributed systems.</div><form aria-label="Application"><label for="why">Why would you be a good fit?</label><p id="help">Describe relevant experience.</p><textarea id="why" aria-describedby="help"></textarea></form></main>`, { url: 'https://jobs.example.com/role' });
  const result = inspectDocument(window.document);
  assert.equal(result.page.jobDescription, 'Build reliable distributed systems.');
  assert.equal(result.page.role, 'Platform Engineer');
  assert.equal(result.fields[0].helpText, 'Describe relevant experience.');
  assert.equal(result.fields[0].labelConfidence, 'high');
  window.close();
});

test('generator composes from job context and experience, with evidence references', async () => {
  assert.equal(typeof llm.callAnswerSuggestions, 'function');
  let body;
  const result = await llm.callAnswerSuggestions({ apiKey: 'test', field: { id: 'why', label: 'Why this role?', type: 'textarea' },
    page: { jobDescription: 'Build distributed systems', role: 'Engineer' },
    records: [{ key: 'experience', question: 'Experience', answer: 'Built event processing services' }] }, {
    fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({ output_text: JSON.stringify({ suggestions: [{ answer: 'My experience building event processing services is relevant to this role.', evidenceKeys: ['experience'] }], missingContext: '' }) }) }; },
  });
  assert.equal(result.suggestions.length, 1);
  assert.match(body.input[1].content[0].text, /distributed systems/);
  assert.match(body.input[1].content[0].text, /event processing/);
  assert.equal(body.store, false);
});

test('generator rejects unsupported evidence and returns missing context without invented alternatives', async () => {
  assert.equal(typeof llm.callAnswerSuggestions, 'function');
  const input = { apiKey: 'test', field: { id: 'why', label: 'Why?', type: 'textarea' }, records: [] };
  const response = (data) => ({ fetchImpl: async () => ({ ok: true, json: async () => ({ output_text: JSON.stringify(data) }) }) });
  await assert.rejects(llm.callAnswerSuggestions(input, response({ suggestions: [{ answer: 'Ten years experience', evidenceKeys: ['invented'] }], missingContext: '' })), /evidence/i);
  assert.deepEqual(await llm.callAnswerSuggestions(input, response({ suggestions: [], missingContext: 'Add your relevant experience.' })), { suggestions: [], missingContext: 'Add your relevant experience.' });
});
