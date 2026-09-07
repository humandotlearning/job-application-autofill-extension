import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseRecord,
  inferSensitivity,
  normalizeAnswerRecord,
  normalizeText,
  shouldReviewDecision,
  slugify,
  upsertAnswerRecords,
  validateFillValue,
} from '../src/core.js';

test('normalizes labels and creates stable canonical keys', () => {
  assert.equal(normalizeText('  Phone Number * (required) '), 'phone number');
  assert.equal(normalizeText('LinkedIn URL'), 'linkedin url');
  assert.equal(slugify('Why do you want this role?'), 'why_do_you_want_this_role');
});

test('matches autocomplete metadata before labels and aliases', () => {
  const records = [
    { key: 'email', question: 'Email address', answer: 'person@example.com', aliases: ['E-mail'], sensitivity: 'safe' },
    { key: 'current_employer', question: 'Current company', answer: 'Example Ltd', aliases: ['Employer'], sensitivity: 'safe' },
  ];
  const match = chooseRecord({ label: 'Work email', autocomplete: 'email', name: 'candidateEmail', type: 'email' }, records);
  assert.equal(match.record.key, 'email');
  assert.equal(match.confidence, 'exact');
});

test('normalizes hyphenated autocomplete tokens and refuses misleading URL matches', () => {
  const records = [
    { key: 'given_name', question: 'First name', answer: 'Ada', sensitivity: 'safe' },
    { key: 'linkedin', question: 'LinkedIn profile', answer: 'https://linkedin.example/ada', sensitivity: 'safe' },
    { key: 'github', question: 'GitHub profile', answer: 'https://github.example/ada', sensitivity: 'safe' },
  ];
  assert.equal(chooseRecord({ label: 'Applicant', autocomplete: 'given-name' }, records)?.record.key, 'given_name');
  assert.equal(chooseRecord({ label: 'GitHub URL', autocomplete: 'url' }, records)?.record.key, 'github');
});

test('does not fill a generic name field from a first-name-only record', () => {
  assert.equal(chooseRecord({ label: 'Name' }, [{
    key: 'first_name', question: 'First name', answer: 'Ada', sensitivity: 'safe',
  }]), null);
  assert.equal(chooseRecord({ label: 'Name' }, [{
    key: 'full_name', question: 'Full name', answer: 'Ada Lovelace', sensitivity: 'safe',
  }])?.record.key, 'full_name');
});

test('matches stable concepts across common question synonyms', () => {
  const match = chooseRecord({ label: 'Birthday' }, [{
    key: 'date_of_birth', question: 'Date of birth', answer: '1990-01-02', sensitivity: 'safe',
  }]);
  assert.equal(match?.record.key, 'date_of_birth');
});

test('leaves equally plausible records unresolved instead of guessing', () => {
  assert.equal(chooseRecord({ label: 'Current company' }, [
    { key: 'company_1', question: 'Company', answer: 'One', aliases: ['Current company'], sensitivity: 'safe' },
    { key: 'company_2', question: 'Company', answer: 'Two', aliases: ['Current company'], sensitivity: 'safe' },
  ]), null);
});

test('does not confuse different name concepts or choose conflicting canonical records', () => {
  assert.equal(chooseRecord({ label: 'Preferred name' }, [{ key: 'first_name', answer: 'Ada' }]), null);
  assert.equal(chooseRecord({ label: 'First name' }, [{ key: 'full_name', answer: 'Ada Lovelace' }]), null);
  assert.equal(chooseRecord({ label: 'Name' }, [
    { key: 'full_name', answer: 'Ada Lovelace' }, { key: 'legal_name', answer: 'Grace Hopper' },
  ]), null);
});

test('keeps scoped repeated records separate while retaining the shared label alias', () => {
  const merged = upsertAnswerRecords([], [
    { key: 'company__entry_1', question: 'Company', answer: 'Analytical Engines', aliases: ['Company'], entityId: 'employment-1' },
    { key: 'company__entry_2', question: 'Company', answer: 'Ada Computing', aliases: ['Company'], entityId: 'employment-2' },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((record) => record.answer), ['Analytical Engines', 'Ada Computing']);
});

test('migration preserves identical legacy keys belonging to different entities', () => {
  const merged = upsertAnswerRecords([], [
    { key: 'company', question: 'Company', answer: 'One', entityId: 'job1' },
    { key: 'company', question: 'Company', answer: 'Two', entityId: 'job2' },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(upsertAnswerRecords(merged, merged).map((record) => record.key), merged.map((record) => record.key));
});

test('prefers the matching repeated-entry scope when labels are identical', () => {
  const match = chooseRecord({ label: 'Company', entityId: 'employment-2' }, [
    { key: 'company__entry_1', question: 'Company', answer: 'One', entityId: 'employment-1', aliases: ['Company'] },
    { key: 'company__entry_2', question: 'Company', answer: 'Two', entityId: 'employment-2', aliases: ['Company'] },
  ]);
  assert.equal(match?.record.answer, 'Two');
});

test('does not fall back to another employment entity or shared section', () => {
  assert.equal(chooseRecord({ label: 'Company', entityId: 'job2', section: 'Employment' }, [
    { key: 'company', question: 'Company', answer: 'Acme', entityId: 'job1', context: 'Employment' },
  ]), null);
});

test('reuses one saved employer across different site-specific work-history sections', () => {
  const match = chooseRecord({
    label: 'Employer name',
    entityId: 'workday-history-1',
    entityType: 'employment',
    employmentId: 'deepsight-ai-labs',
  }, [{
    key: 'employer_name_workday_1',
    question: 'Company',
    answer: 'DeepSight AI Labs',
    aliases: ['Employer name', 'Company'],
    entityId: 'lever-experience-0',
    entityType: 'employment',
    employmentId: 'deepsight-ai-labs',
    sensitivity: 'safe',
  }]);
  assert.equal(match?.record.answer, 'DeepSight AI Labs');
});

test('infers conservative sensitivity for high-impact questions', () => {
  assert.equal(inferSensitivity('Expected CTC'), 'review');
  assert.equal(inferSensitivity('I agree to the privacy policy'), 'legal');
  assert.equal(inferSensitivity('Portfolio URL'), 'safe');
});

test('validates options, patterns, lengths, and numeric bounds', () => {
  assert.equal(validateFillValue({ type: 'select', options: ['India', 'United States'] }, 'India').ok, true);
  assert.equal(validateFillValue({ type: 'select', options: ['India', 'United States'] }, 'Canada').ok, false);
  assert.equal(validateFillValue({ type: 'text', constraints: { pattern: '^[A-Z]+$' } }, 'Nithin').ok, false);
  assert.equal(validateFillValue({ type: 'text', constraints: { minLength: 3, maxLength: 5 } }, 'Nithin').ok, false);
  assert.equal(validateFillValue({ type: 'number', constraints: { min: '1', max: '10' } }, '12').ok, false);
  assert.equal(validateFillValue({ type: 'email' }, 'person@example.com').ok, true);
});

test('only high-confidence safe short answers are unreviewed', () => {
  const field = { type: 'text', label: 'Full name' };
  assert.equal(shouldReviewDecision({ confidence: 'high', sensitivity: 'safe', value: 'Nithin' }, field), false);
  assert.equal(shouldReviewDecision({ confidence: 'medium', sensitivity: 'safe', value: 'Nithin' }, field), true);
  assert.equal(shouldReviewDecision({ confidence: 'high', sensitivity: 'review', value: '14 days' }, field), true);
  assert.equal(shouldReviewDecision({ confidence: 'high', sensitivity: 'safe', value: 'long answer' }, { type: 'textarea' }), true);
});

test('normalizes learned records and latest confirmation wins while aliases accumulate', () => {
  const existing = [normalizeAnswerRecord({
    key: 'full_name',
    question: 'Full Name',
    answer: 'Old Name',
    aliases: ['Candidate name'],
    sensitivity: 'safe',
    updatedAt: '2025-01-01T00:00:00.000Z',
  })];
  const merged = upsertAnswerRecords(existing, [{
    key: 'full_name',
    question: 'Your legal name',
    answer: 'New Name',
    aliases: ['Legal name'],
    type: 'text',
    sensitivity: 'safe',
  }], '2026-01-01T00:00:00.000Z');
  assert.deepEqual(merged, [{
    key: 'full_name',
    question: 'Your legal name',
    answer: 'New Name',
    aliases: ['Candidate name', 'Legal name', 'Full Name', 'Your legal name'],
    type: 'text',
    sensitivity: 'safe',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }]);
});

test('retains user correction history when a confirmed answer changes', () => {
  const merged = upsertAnswerRecords([
    { key: 'email', question: 'Email', answer: 'old@example.com', provenance: 'user', updatedAt: '2025-01-01T00:00:00.000Z' },
  ], [{
    key: 'email', question: 'Email address', answer: 'new@example.com', provenance: 'user',
  }], '2026-01-01T00:00:00.000Z');
  assert.deepEqual(merged[0].history.map((item) => item.answer), ['old@example.com']);
});

test('keeps existing records with a safe migration shape', () => {
  const record = normalizeAnswerRecord({
    key: 'email',
    question: 'Email',
    answer: 'person@example.com',
    status: 'verified',
    source: 'obsolete-source',
  });
  assert.deepEqual(record, {
    key: 'email',
    question: 'Email',
    answer: 'person@example.com',
    aliases: ['Email'],
    type: 'text',
    sensitivity: 'safe',
    updatedAt: record.updatedAt,
  });
  assert.equal('source' in record, false);
  assert.equal('status' in record, false);
});
