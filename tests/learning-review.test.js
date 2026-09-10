import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLearningCandidates, callLearningReviewer, sanitizeLearningProposals } from '../src/learning-review.js';

test('learning candidates include only clear safe user-entered values without exposing ordinary answers', () => {
  const candidates = buildLearningCandidates([
    {
      key: 'favorite_language', question: 'What is your favorite programming language?', answer: 'JavaScript',
      type: 'text', provenance: 'user', completed: true, userEdited: true, labelConfidence: 'high',
    },
    {
      key: 'salary', question: 'Expected salary', answer: '100000', type: 'number',
      provenance: 'user', completed: true, userEdited: true,
    },
    {
      key: 'vendor_8f14e45fceea167a5a36dedd4bea2543', question: '8f14e45fceea167a5a36dedd4bea2543', answer: 'ignored',
      type: 'text', provenance: 'user', completed: true, userEdited: true,
    },
  ]);

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0], {
    id: 'favorite_language',
    label: 'What is your favorite programming language?',
    type: 'text',
    valueShape: 'short_text',
    scope: { entityId: '', entityType: '', employmentId: '', context: '' },
    options: [],
    constraints: {},
    narrative: '',
  });
  assert.doesNotMatch(JSON.stringify(candidates), /JavaScript|100000|8f14e45fceea167a5a36dedd4bea2543/);
});

test('learning candidates include only bounded safe narrative text when needed for topic metadata', () => {
  const answer = `Built event-driven services with reliable retry handling. ${'x'.repeat(1300)}`;
  const [candidate] = buildLearningCandidates([{
    key: 'deployment_story', question: 'Describe a deployment project', answer, type: 'textarea',
    provenance: 'user', completed: true, userEdited: true, labelConfidence: 'high',
  }]);

  assert.equal(candidate.valueShape, 'long_text');
  assert.equal(candidate.narrative.length, 1200);
  assert.match(candidate.narrative, /^Built event-driven services/);
});

test('learning proposal cleanup keeps human metadata and removes jargon and code-like tags', () => {
  const candidates = [{
    id: 'favorite_language', label: 'What is your favorite programming language?', type: 'text', valueShape: 'short_text',
    scope: { entityId: '', entityType: '', employmentId: '', context: '' }, options: [], constraints: {}, narrative: '',
  }];
  const [proposal] = sanitizeLearningProposals({ reviews: [{
    candidateId: 'favorite_language', outcome: 'propose', canonicalKey: 'favorite_programming_language',
    displayLabel: 'Favorite programming language', intent: 'preference', valueKind: 'short_text',
    aliases: ['Preferred coding language', 'ATS_Response_7a91f4cb64da'],
    topicTags: ['programming', 'language', 'response', '7a91f4cb64da'], scope: 'global',
    reusePolicy: 'suggest_only', confidence: 'high',
  }] }, candidates, { model: 'gpt-5.6-terra', now: '2026-09-08T00:00:00.000Z' });

  assert.deepEqual(proposal, {
    candidateId: 'favorite_language', outcome: 'propose', canonicalKey: 'favorite_programming_language',
    displayLabel: 'Favorite programming language', intent: 'preference', valueKind: 'short_text',
    aliases: ['Preferred coding language'], topicTags: ['programming', 'language'],
    scope: { entityId: '', entityType: '', employmentId: '', context: '' }, reusePolicy: 'suggest_only', confidence: 'high',
    classifier: { model: 'gpt-5.6-terra', promptVersion: 'learning-review-v1', classifiedAt: '2026-09-08T00:00:00.000Z' },
  });
});

test('Fireworks learning review uses its strict schema and 3000 token budget', async () => {
  let body;
  const candidates = [{ id: 'favorite_language', label: 'Favorite programming language', type: 'text', valueShape: 'short_text', scope: {}, options: [], constraints: {}, narrative: '' }];
  const reviews = [{ candidateId: 'favorite_language', outcome: 'reject', canonicalKey: '', displayLabel: '', intent: 'other', valueKind: 'short_text', aliases: [], topicTags: [], scope: 'global', reusePolicy: 'never', confidence: 'low' }];
  await callLearningReviewer({ apiKey: 'test', candidates }, { provider: 'fireworks', fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ reviews }) } }] }) }; } });
  assert.equal(body.max_tokens, 3000);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.name, 'learning_review');
  assert.match(body.messages[0].content, /JSON schema/);
});
