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
