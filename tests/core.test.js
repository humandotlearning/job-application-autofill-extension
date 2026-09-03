import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGoogleSheetCsvUrl,
  chooseRecord,
  normalizeText,
  parseCsv,
  rowsToRecords,
  shouldAutofill,
} from '../src/core.js';

test('normalizes labels without losing semantic words', () => {
  assert.equal(normalizeText('  Phone Number * (required) '), 'phone number');
  assert.equal(normalizeText('LinkedIn URL'), 'linkedin url');
});

test('parses quoted commas, escaped quotes, and newlines', () => {
  const csv = 'Question,Answer,Aliases\r\n"Why us?","I build, ship, and learn","Why this company?;Motivation"\r\n"Note","Line 1\nLine 2",""';
  assert.deepEqual(parseCsv(csv), [
    ['Question', 'Answer', 'Aliases'],
    ['Why us?', 'I build, ship, and learn', 'Why this company?;Motivation'],
    ['Note', 'Line 1\nLine 2', ''],
  ]);
});

test('converts a question-answer sheet into reusable records', () => {
  const rows = [
    ['Key', 'Question', 'Answer', 'Aliases', 'Type', 'Status', 'Sensitivity'],
    ['notice_period', 'What is your notice period?', '14 days', 'Availability;How soon can you join?', 'text', 'verified', 'review'],
  ];
  assert.deepEqual(rowsToRecords(rows), [{
    key: 'notice_period',
    question: 'What is your notice period?',
    answer: '14 days',
    aliases: ['Availability', 'How soon can you join?'],
    type: 'text',
    status: 'verified',
    sensitivity: 'review',
    options: [],
    source: 'google-sheet',
  }]);
});

test('supports a simple two-column Field and Value sheet', () => {
  const rows = [
    ['Field', 'Value'],
    ['Email Address', 'person@example.com'],
    ['Phone', '9999999999'],
  ];
  assert.equal(rowsToRecords(rows)[0].key, 'email_address');
  assert.equal(rowsToRecords(rows)[1].answer, '9999999999');
});

test('supports plural Questions and Answers headers used by the workbook', () => {
  const rows = [
    ['Questions', 'Answers'],
    ['Why do you want this role?', 'To build useful AI products.'],
  ];
  assert.equal(rowsToRecords(rows)[0].key, 'why_do_you_want_this_role');
});

test('supports the headerless key-value layout used by Sheet1', () => {
  const rows = [
    ['LinkedIn:', 'https://www.linkedin.com/in/example'],
    ['github:', 'https://github.com/example'],
    ['', ''],
  ];
  const records = rowsToRecords(rows);
  assert.deepEqual(records.map((record) => record.key), ['linkedin', 'github']);
});

test('builds a Google Visualization CSV URL from the supplied sheet', () => {
  const input = 'https://docs.google.com/spreadsheets/d/1SoKWd8RL1YpZxP3Bvs5bclF_fhs47VZpk1wh6H6UBJ0/edit?gid=0#gid=0';
  assert.equal(
    buildGoogleSheetCsvUrl(input),
    'https://docs.google.com/spreadsheets/d/1SoKWd8RL1YpZxP3Bvs5bclF_fhs47VZpk1wh6H6UBJ0/gviz/tq?tqx=out:csv&gid=0',
  );
});

test('matches autocomplete metadata before fuzzy labels', () => {
  const records = rowsToRecords([
    ['Key', 'Question', 'Answer', 'Aliases', 'Status'],
    ['email', 'Email Address', 'person@example.com', 'Email;E-mail', 'verified'],
    ['current_employer', 'Current company', 'Example Ltd', 'Employer', 'verified'],
  ]);
  const match = chooseRecord({ label: 'Work email', autocomplete: 'email', name: 'candidateEmail', type: 'email' }, records);
  assert.equal(match.record.key, 'email');
  assert.equal(match.confidence, 'exact');
});

test('does not automatically fill review-gated or unverified answers', () => {
  assert.equal(shouldAutofill({ status: 'verified', sensitivity: 'safe' }), true);
  assert.equal(shouldAutofill({ status: 'draft', sensitivity: 'safe' }), false);
  assert.equal(shouldAutofill({ status: 'verified', sensitivity: 'review' }), false);
  assert.equal(shouldAutofill({ status: 'verified', sensitivity: 'legal' }), false);
});

test('defaults sensitive questions to review when the sheet omits policy', () => {
  const records = rowsToRecords([
    ['Field', 'Value'],
    ['Expected CTC', '5000000'],
    ['I consent to SMS messages', 'Yes'],
    ['Portfolio URL', 'https://example.com'],
  ]);
  assert.equal(records[0].sensitivity, 'review');
  assert.equal(records[1].sensitivity, 'legal');
  assert.equal(records[2].sensitivity, 'safe');
});
