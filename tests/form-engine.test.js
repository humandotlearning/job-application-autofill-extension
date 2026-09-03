import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { collectChangedResponses, scanAndFillDocument } from '../src/form-engine.js';

function makeDocument(html) {
  return new JSDOM(html, { url: 'https://jobs.example.com/apply' }).window.document;
}

test('captures only user-completed learnable fields and excludes sensitive questions', () => {
  const document = makeDocument(`
    <form>
      <label for="why">Why do you want this role?</label><textarea id="why">Build useful products</textarea>
      <label for="salary">Expected CTC</label><input id="salary" value="6000000">
      <label for="email">Email</label><input id="email" value="person@example.com">
    </form>
  `);
  const initial = new Map([
    ['why', ''],
    ['salary', ''],
    ['email', 'person@example.com'],
  ]);
  const records = collectChangedResponses(document, initial);
  assert.deepEqual(records.map(({ question, answer, sensitivity }) => ({ question, answer, sensitivity })), [
    { question: 'Why do you want this role?', answer: 'Build useful products', sensitivity: 'safe' },
    { question: 'Expected CTC', answer: '6000000', sensitivity: 'review' },
  ]);
});


test('fills all safe known fields in one pass and dispatches form events', () => {
  const document = makeDocument(`
    <form>
      <label for="name">Full Name</label><input id="name" required>
      <label for="email">Email Address</label><input id="email" type="email" autocomplete="email" required>
      <label for="phone">Phone Number</label><input id="phone" type="tel">
    </form>
  `);
  let changes = 0;
  document.querySelector('#email').addEventListener('change', () => changes++);
  const records = [
    { key: 'full_name', question: 'Full Name', answer: 'Nithin Varghese', aliases: ['Name'], status: 'verified', sensitivity: 'safe', type: 'text', options: [] },
    { key: 'email', question: 'Email Address', answer: 'person@example.com', aliases: ['Email'], status: 'verified', sensitivity: 'safe', type: 'email', options: [] },
    { key: 'phone', question: 'Phone Number', answer: '9999999999', aliases: ['Mobile'], status: 'verified', sensitivity: 'safe', type: 'tel', options: [] },
  ];

  const report = scanAndFillDocument(document, records, { fill: true });

  assert.equal(document.querySelector('#name').value, 'Nithin Varghese');
  assert.equal(document.querySelector('#email').value, 'person@example.com');
  assert.equal(document.querySelector('#phone').value, '9999999999');
  assert.equal(changes, 1);
  assert.equal(report.filled.length, 3);
  assert.equal(report.unknown.length, 0);
});

test('reports review-gated fields without changing them', () => {
  const document = makeDocument('<label for="salary">Expected CTC</label><input id="salary" required>');
  const records = [{ key: 'expected_ctc', question: 'Expected CTC', answer: '5000000', aliases: [], status: 'verified', sensitivity: 'review', type: 'number', options: [] }];

  const report = scanAndFillDocument(document, records, { fill: true });

  assert.equal(document.querySelector('#salary').value, '');
  assert.equal(report.review.length, 1);
  assert.equal(report.requiredEmpty.length, 1);
});

test('selects matching options and leaves submit controls untouched', () => {
  const document = makeDocument(`
    <label for="country">Country</label>
    <select id="country"><option value="">Choose</option><option value="IN">India</option></select>
    <button type="submit">Submit application</button>
  `);
  const records = [{ key: 'country', question: 'Country', answer: 'India', aliases: [], status: 'verified', sensitivity: 'safe', type: 'select', options: [] }];

  const report = scanAndFillDocument(document, records, { fill: true });

  assert.equal(document.querySelector('#country').value, 'IN');
  assert.equal(report.filled.length, 1);
  assert.equal(document.querySelector('button').textContent, 'Submit application');
});

test('matches a radio group by its legend and selects the answer', () => {
  const document = makeDocument(`
    <fieldset><legend>Are you willing to relocate?</legend>
      <label><input type="radio" name="relocate" value="Yes">Yes</label>
      <label><input type="radio" name="relocate" value="No">No</label>
    </fieldset>
  `);
  const records = [{ key: 'relocate', question: 'Are you willing to relocate?', answer: 'Yes', aliases: ['Willing to relocate'], status: 'verified', sensitivity: 'safe', type: 'radio', options: [] }];

  const report = scanAndFillDocument(document, records, { fill: true });

  assert.equal(document.querySelector('input[value="Yes"]').checked, true);
  assert.equal(report.filled.length, 1);
});

test('fills a review-only email template only when explicitly enabled', () => {
  const document = makeDocument('<textarea aria-label="Cover Letter"></textarea>');
  const records = [{
    key: 'email_template',
    question: 'Application email or cover letter',
    answer: 'Hello hiring team',
    aliases: ['Cover Letter'],
    type: 'email-template',
    status: 'draft',
    sensitivity: 'review',
  }];
  const review = scanAndFillDocument(document, records, { fill: true });
  assert.equal(review.filled.length, 0);
  assert.equal(review.review.length, 1);
  const filled = scanAndFillDocument(document, records, { fill: true, includeEmailTemplates: true });
  assert.equal(filled.filled.length, 1);
  assert.equal(document.querySelector('textarea').value, 'Hello hiring team');
});
