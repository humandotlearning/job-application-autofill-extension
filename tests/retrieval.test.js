import test from 'node:test';
import assert from 'node:assert/strict';

test('saved field candidates keep saved evidence first and add distinct completed drafts', async () => {
  const { savedFieldCandidates } = await import('../src/retrieval.js');
  const field = { label: 'Preferred work location', type: 'text' };
  const saved = [
    { key: 'a_remote', question: 'Preferred work location', answer: 'Remote', confirmationState: 'confirmed', sensitivity: 'safe' },
    { key: 'b_bangalore', question: 'Preferred work location', answer: 'Bangalore', confirmationState: 'confirmed', sensitivity: 'safe' },
  ];
  const drafts = [
    { key: 'draft:remote', question: 'Preferred work location', answer: 'Remote', confirmationState: 'confirmed', completed: true, sensitivity: 'safe' },
    { key: 'draft:a_hyderabad', question: 'Preferred work location', answer: 'Hyderabad', confirmationState: 'confirmed', completed: true, sensitivity: 'safe' },
    { key: 'draft:chennai', question: 'Preferred work location', answer: 'Chennai', confirmationState: 'confirmed', completed: true, sensitivity: 'safe' },
    { key: 'draft:pending', question: 'Unrelated question', answer: 'Pending answer', confirmationState: 'pending', completed: true, sensitivity: 'safe' },
    { key: 'cards|d20089ff-f389-44ef-9398-eec15ba7b6a4[field1]', question: 'Preferred work location', answer: 'Opaque answer', confirmationState: 'confirmed', completed: true, sensitivity: 'safe' },
    { key: 'draft:incompatible', question: 'Describe a different experience', answer: 'Built unrelated services for a different domain.', confirmationState: 'confirmed', completed: true, sensitivity: 'safe' },
  ];

  const candidates = savedFieldCandidates(field, saved, drafts);

  assert.deepEqual(candidates.map((candidate) => candidate.answer), ['Remote', 'Bangalore', 'Hyderabad']);
  assert.equal(candidates[0].kind, 'equivalent');
  assert.equal(candidates[2].kind, 'draft');
  assert.equal(candidates[2].provenance, 'saved record');
  assert.equal(candidates[2].reason, 'Previously entered, not yet saved for reuse — explicit approval required');
  assert.equal(candidates.some((candidate) => candidate.answer === 'Pending answer' || candidate.answer === 'Opaque answer' || candidate.answer === 'Built unrelated services for a different domain.'), false);
});

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

test('retrieves a human-readable saved answer for reviewed choice mapping', async () => {
  const { retrieveEvidence } = await import('../src/retrieval.js');
  const record = {
    key: 'how_did_you_hear_about_this_job',
    question: 'How did you hear about this job?',
    answer: 'My Hermes agent found the role relevant to my profile',
    confirmationState: 'confirmed',
    sensitivity: 'safe',
  };
  const candidates = retrieveEvidence({ label: 'How did you hear about us?', type: 'select', options: ['Recruiter', 'Company website'] }, [record]);
  assert.equal(candidates[0]?.sourceKey, record.key);
  assert.equal(candidates[0]?.kind, 'choice_mapping');
  assert.equal(candidates[0]?.requiresApproval, true);
});

test('saved-answer search is not capped by the three recommendation slots', async () => {
  const { searchEvidence } = await import('../src/retrieval.js');
  const records = ['First', 'Second', 'Third', 'Fourth'].map((answer, index) => ({
    key: `tool_${index}`,
    question: 'Preferred tool',
    answer,
    confirmationState: 'confirmed',
    sensitivity: 'safe',
  }));
  const candidates = searchEvidence({ label: 'Preferred tool', type: 'text' }, records, { limit: 20 });
  assert.deepEqual(candidates.map((candidate) => candidate.answer), ['First', 'Second', 'Third', 'Fourth']);
});

test('explicit saved-answer search finds missed question matches and collapses duplicate answers', async () => {
  const { searchEvidence } = await import('../src/retrieval.js');
  const records = [
    { key: 'legacy_profile', question: 'Professional profile', answer: 'https://linkedin.com/in/person', confirmationState: 'confirmed', sensitivity: 'safe' },
    { key: 'linkedin_url', question: 'LinkedIn URL', answer: 'https://linkedin.com/in/person', confirmationState: 'confirmed', sensitivity: 'safe' },
    { key: 'github_url', question: 'GitHub URL', answer: 'https://github.com/person', confirmationState: 'confirmed', sensitivity: 'safe' },
  ];
  const candidates = searchEvidence({ label: 'Where can we learn more about you?', type: 'url' }, records, { query: 'linkedin', limit: 20 });
  assert.deepEqual(candidates.map((candidate) => candidate.answer), ['https://linkedin.com/in/person']);
  assert.equal(candidates[0].sourceKey, 'linkedin_url');
});

test('inline profile candidates exclude wrong-purpose URLs but preserve valid conflicts', async () => {
  const { savedFieldCandidates } = await import('../src/retrieval.js');
  const records = [
    { key: 'github', question: 'GitHub', answer: 'https://github.com/person', confirmationState: 'confirmed', sensitivity: 'safe' },
    { key: 'github_repo', question: 'GitHub URL', answer: 'https://github.com/person/project', confirmationState: 'confirmed', sensitivity: 'safe' },
    { key: 'portfolio', question: 'GitHub URL', answer: 'https://person.github.io/', confirmationState: 'confirmed', sensitivity: 'safe' },
    { key: 'linkedin', question: 'LinkedIn', answer: 'https://www.linkedin.com/in/person', confirmationState: 'confirmed', sensitivity: 'safe' },
    { key: 'linkedin_username', question: 'LinkedIn profile URL', answer: 'person1357', confirmationState: 'confirmed', sensitivity: 'safe' },
    { key: 'linkedin_conflict', question: 'LinkedIn profile URL', answer: 'https://www.linkedin.com/pub/person-profile', confirmationState: 'confirmed', sensitivity: 'safe' },
  ];
  const githubCandidates = savedFieldCandidates({ label: 'GitHub URL', type: 'url' }, records);
  assert.deepEqual(githubCandidates.map((candidate) => candidate.answer), ['https://github.com/person']);
  const linkedinCandidates = savedFieldCandidates({ label: 'LinkedIn URL', type: 'url' }, records);
  assert.deepEqual(linkedinCandidates.map((candidate) => candidate.answer), ['https://www.linkedin.com/in/person', 'https://www.linkedin.com/pub/person-profile']);
  assert.equal(records[1].answer, 'https://github.com/person/project');
  assert.equal(records[4].answer, 'person1357');
});

test('search preserves distinct literal URLs and finds aliases beyond the first twenty records', async () => {
  const { searchEvidence } = await import('../src/retrieval.js');
  const records = Array.from({length: 25}, (_, i) => ({key: `record_${i}`, question: 'Preferred tool', answer: `Tool ${i}`}));
  records.push(...['https://example.com/a-b', 'https://example.com/a/b', 'https://example.com/A/b', 'https://example.com/a-b'].map((answer, i) => ({key: `url_${i}`, question: 'Profile address', aliases: ['find profile'], answer})));
  const results = searchEvidence({label: 'Where can we learn more?', type: 'url'}, records, {query: 'find profile'});
  assert.deepEqual(results.map(item => item.answer), ['https://example.com/a-b', 'https://example.com/a/b', 'https://example.com/A/b']);
});
