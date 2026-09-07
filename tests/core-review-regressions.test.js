import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseRecord, canonicalConcept, recordScopeCompatible } from '../src/core.js';
import { retrieveEvidence } from '../src/retrieval.js';

test('B2: formatting cannot hide numeric compensation with missing period', () => {
  for (const answer of ['1,200,000', '₹1200000', '1200000 INR', '$120,000.00', '1 200 000', '20 LPA']) {
    const record = saved({ question: 'Current salary', answer });
    const field = { label: 'Current annual salary', name: 'current_salary' };
    assert.equal(chooseRecord(field, [record]), null, answer);
    assert.deepEqual(retrieveEvidence(field, [record]), [], answer);
  }
});

test('B3: city and general location remain distinct and cannot cross-fill', () => {
  const record = { key: 'current_location', question: 'Current location', aliases: ['Current city'], answer: '123 MG Road, Bangalore, Karnataka 560001, India', sensitivity: 'safe' };
  assert.notEqual(canonicalConcept('Current city'), canonicalConcept('Current location'));
  assert.equal(chooseRecord({ label: 'Current city', name: 'current_location', autocomplete: 'address-level2' }, [record]), null);
  assert.deepEqual(retrieveEvidence({ label: 'Current city' }, [record]), []);
  assert.equal(chooseRecord({ label: 'Present city' }, [{ key: 'current_city', question: 'Current city', answer: 'Bangalore' }])?.score, 1);
});

test('B4: aliases cannot override protected identity concepts on any matching path', () => {
  for (const [label, concept, autocomplete] of [['First name', 'preferred_name', 'given-name'], ['Last name', 'first_name', 'family-name'], ['LinkedIn URL', 'github_url', 'url'], ['Date of birth', 'first_name', '']]) {
    const record = { key: concept, concept, question: concept.replaceAll('_', ' '), aliases: [label], answer: 'Synthetic', sensitivity: 'safe' };
    assert.equal(chooseRecord({ label, autocomplete }, [record]), null, label);
    assert.deepEqual(retrieveEvidence({ label, autocomplete }, [record]), [], label);
  }
});

test('employmentId-only scope rejects conflicting and unscoped destinations', () => {
  const record = { key: 'ml_job_a', question: 'Describe your machine learning experience', answer: 'I built production models at Company A.', employmentId: 'job-a', confirmationState: 'confirmed', sensitivity: 'safe' };
  for (const scope of [{ employmentId: 'job-b', entityType: 'employment' }, {}, { employmentId: 'job-b', entityId: 'same' }]) {
    const field = { label: record.question, ...scope };
    assert.equal(recordScopeCompatible(field, record), false);
    assert.equal(chooseRecord(field, [record]), null);
    assert.deepEqual(retrieveEvidence(field, [record]), []);
  }
  assert.equal(chooseRecord({ label: record.question, employmentId: 'job-a', entityType: 'employment' }, [record])?.score, 1);
});

test('untagged narrative topic/action overlap yields only reviewable sourced evidence', () => {
  const field = { label: 'Describe your experience building data pipelines', type: 'textarea' };
  const record = { key: 'etl', question: 'Describe a data pipeline project', answer: 'I built scalable pipelines processing billions of records daily.', sensitivity: 'safe', confirmationState: 'confirmed', provenance: 'user' };
  const evidence = retrieveEvidence(field, [record]);
  assert.equal(evidence[0]?.sourceKey, 'etl');
  assert.equal(evidence[0].kind, 'related');
  assert.equal(evidence[0].requiresApproval, true);
  assert.equal(evidence[0].answer, record.answer);
  assert.equal(evidence[0].provenance, 'user');
  assert.match(evidence[0].reason, /not an asserted qualification/);
  for (const change of [{ confirmationState: 'pending' }, { answer: 'I never built data pipelines in production.' }, { question: 'Why join our data pipeline company?' }, { answer: 'I studied scalable data pipelines during university courses.' }, { question: 'Describe a marketing project', answer: 'I built scalable marketing campaigns for retail customers.' }, { employmentId: 'other' }]) {
    assert.deepEqual(retrieveEvidence(field, [{ ...record, ...change }]), [], JSON.stringify(change));
  }
  assert.deepEqual(retrieveEvidence({ label: 'Are you qualified building data pipelines?', type: 'radio' }, [record]), []);
});

test('B1: a scale embedded only in the amount cannot bypass the scale guard', () => {
  const record = saved({ question: 'Current annual salary in INR', answer: '20 LPA' });
  assert.equal(chooseRecord({ label: record.question }, [record]), null);
  assert.deepEqual(retrieveEvidence({ label: record.question }, [record]), []);
});

const saved = (changes = {}) => ({ key: 'current_salary', question: 'Current salary in INR LPA', answer: '20', sensitivity: 'review', confirmationState: 'confirmed', ...changes });

test('B1: lakh-per-annum amounts never reuse raw annual currency amounts', () => {
  const field = { label: 'Current salary annually in INR', name: 'current_salary' };
  assert.equal(chooseRecord(field, [saved()]), null);
  assert.deepEqual(retrieveEvidence(field, [saved()]), []);
  assert.equal(chooseRecord({ label: 'Current salary in INR LPA' }, [saved()])?.score, 1);
});
