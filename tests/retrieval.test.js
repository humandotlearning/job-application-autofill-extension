import test from 'node:test';
import assert from 'node:assert/strict';

test('unspecified compensation units expose verbatim LPA evidence only for review', async () => {
  const { retrieveEvidence } = await import('../src/retrieval.js');
  const { chooseRecord } = await import('../src/core.js');
  for (const [label, question, answer] of [['Current CTC', 'Current salary', 'Last reported salary was 18 LPA; please review.'], ['Expected CTC', 'Expected CTC', '30-45 LPA']]) {
    const record = { key: 'stable', question, answer, sensitivity: 'review', confirmationState: 'confirmed' };
    assert.equal(chooseRecord({ label, type: 'number' }, [record]), null);
    const candidates = retrieveEvidence({ label, type: 'textarea' }, [record]);
    assert.equal(candidates[0]?.answer, answer);
    assert.equal(candidates[0].kind, 'review');
    assert.match(candidates[0].reason, /no conversion performed/);
    assert.deepEqual(retrieveEvidence({ label: `${label} annually in INR`, type: 'number' }, [record]), []);
  }
});

test('legacy positive narrative remains reviewable despite negated question qualification', async () => {
  const { retrieveEvidence } = await import('../src/retrieval.js');
  const records = [{ key: 'legacy_story', question: 'Have you trained models yourself (not via API)?', answer: 'I trained computer vision models and deployed inference to production.', sensitivity: 'safe' }];
  const candidates = retrieveEvidence({ label: 'Describe ML model training experience', type: 'textarea' }, records);
  assert.equal(candidates[0]?.sourceKey, 'legacy_story');
  assert.match(candidates[0].reason, /Unconfirmed saved evidence/);
  assert.equal(records[0].confirmationState, undefined);
});

test('retrieval excludes pending, negated, scoped, generic and company-motivation evidence', async () => {
  const { retrieveEvidence } = await import('../src/retrieval.js');
  const query = { label: 'Describe ML experience', type: 'textarea' };
  const base = { key: 'ml', question: 'ML project', answer: 'Trained and deployed machine learning models.', confirmationState: 'confirmed', sensitivity: 'safe' };
  for (const change of [{ confirmationState: 'pending' }, { confirmationState: 'conflicting', alternatives: ['Other'] }, { answer: 'I have no machine learning experience.' }, { answer: 'Yes' }, { entityId: 'employer-one' }, { question: 'Why join Example ML company?' }, { sensitivity: 'legal' }]) assert.deepEqual(retrieveEvidence(query, [{ ...base, ...change }]), [], JSON.stringify(change));
});

test('related production ML narrative is evidence only, never a qualification', async () => {
  const { retrieveEvidence } = await import('../src/retrieval.js');
  const records = [{ key: 'deployment_story', question: 'Describe a model deployment project', answer: 'I trained machine learning models and deployed computer vision inference into production.', confirmationState: 'confirmed', sensitivity: 'safe', provenance: 'user' }];
  const candidates = retrieveEvidence({ label: 'Tell us about your experience building ML models', type: 'textarea' }, records);
  assert.equal(candidates[0]?.sourceKey, 'deployment_story');
  assert.equal(candidates[0].answer, records[0].answer);
  assert.equal(candidates[0].kind, 'related');
  assert.equal(candidates[0].requiresApproval, true);
  assert.deepEqual(retrieveEvidence({ label: 'Pharma Domain experience?', type: 'radio' }, records), []);
});

test('suppressed saved evidence stays hidden only for its selected destination question', async () => {
  const { retrieveEvidence } = await import('../src/retrieval.js');
  const record = {
    key: 'deployment_story',
    question: 'Describe a model deployment project',
    answer: 'I trained machine learning models and deployed computer vision inference into production.',
    confirmationState: 'confirmed',
    sensitivity: 'safe',
    provenance: 'user',
    suppressedFor: ['describe ml model training experience|textarea'],
  };
  assert.deepEqual(retrieveEvidence({ label: 'Describe ML model training experience', type: 'textarea' }, [record]), []);
  assert.equal(retrieveEvidence({ label: 'Tell us about your experience building ML models', type: 'textarea' }, [record])[0]?.sourceKey, 'deployment_story');
});
