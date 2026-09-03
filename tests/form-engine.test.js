import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  applyDecisions,
  collectAnswerRecords,
  collectFieldDescriptors,
  inspectDocument,
  planDeterministicFill,
  validateDocument,
} from '../src/form-engine.js';

function makeDocument(html) {
  return new JSDOM(html, { url: 'https://jobs.example.com/apply' }).window.document;
}

test('describes supported fields without passwords or hidden inputs', () => {
  const document = makeDocument(`
    <form>
      <label for="name">Full Name</label><input id="name" autocomplete="name" required>
      <label for="country">Country</label><select id="country"><option value="">Choose</option><option value="IN">India</option></select>
      <input type="hidden" name="csrf" value="secret"><input type="password" name="password">
      <input type="file" name="resume">
    </form>
  `);
  const fields = collectFieldDescriptors(document);
  assert.deepEqual(fields.map((field) => field.id), ['name', 'country']);
  assert.equal(fields[0].autocomplete, 'name');
  assert.equal(fields[0].constraints.pattern, undefined);
  assert.deepEqual(fields[1].options, ['Choose', 'India']);
});

test('ignores fields and pause markers inside hidden steps', () => {
  const document = makeDocument(`
    <form><label for="visible">Visible name</label><input id="visible"></form>
    <form hidden><label for="hidden">Hidden name</label><input id="hidden"><p>CAPTCHA</p></form>
  `);
  const inspection = inspectDocument(document);
  assert.deepEqual(inspection.fields.map((field) => field.id), ['visible']);
  assert.deepEqual(inspection.pauseReasons, []);
});

test('fills deterministic safe matches and preserves valid existing values', () => {
  const document = makeDocument(`
    <form>
      <label for="name">Full Name</label><input id="name" required>
      <label for="email">Email Address</label><input id="email" type="email" value="existing@example.com">
    </form>
  `);
  let changes = 0;
  document.querySelector('#name').addEventListener('change', () => changes++);
  const records = [
    { key: 'full_name', question: 'Full Name', answer: 'Nithin Varghese', aliases: ['Name'], sensitivity: 'safe', type: 'text' },
    { key: 'email', question: 'Email Address', answer: 'new@example.com', aliases: [], sensitivity: 'safe', type: 'email' },
  ];
  const decisions = planDeterministicFill(collectFieldDescriptors(document), records);
  const result = applyDecisions(document, decisions);
  assert.equal(document.querySelector('#name').value, 'Nithin Varghese');
  assert.equal(document.querySelector('#email').value, 'existing@example.com');
  assert.equal(changes, 1);
  assert.equal(result.applied.length, 1);
  assert.equal(result.kept.length, 1);
});

test('applies select, radio, and checkbox decisions only when options validate', () => {
  const document = makeDocument(`
    <form>
      <label for="country">Country</label><select id="country"><option value="">Choose</option><option value="IN">India</option></select>
      <fieldset><legend>Willing to relocate?</legend><label><input type="radio" name="relocate" value="Yes">Yes</label><label><input type="radio" name="relocate" value="No">No</label></fieldset>
      <label><input id="consent" type="checkbox"> I agree</label>
    </form>
  `);
  const fields = collectFieldDescriptors(document);
  const result = applyDecisions(document, fields.map((field) => ({
    fieldId: field.id,
    action: 'fill',
    value: field.id === 'country' ? 'India' : field.id === 'relocate' ? 'Yes' : 'Yes',
    evidenceKeys: ['country'],
    confidence: 'high',
    sensitivity: field.id === 'consent' ? 'legal' : 'safe',
    reason: 'known record',
  })));
  assert.equal(result.failed.length, 0);
  assert.equal(document.querySelector('#country').value, 'IN');
  assert.equal(document.querySelector('input[value="Yes"]').checked, true);
  assert.equal(document.querySelector('#consent').checked, true);
});

test('inspects next and submit actions and detects manual pauses', () => {
  const document = makeDocument(`
    <h1>Application step 1</h1><p>Complete the CAPTCHA below.</p>
    <form><label for="name">Name</label><input id="name"><button type="button">Continue</button></form>
    <input type="file" name="resume">
  `);
  const inspection = inspectDocument(document);
  assert.equal(inspection.actions.find((action) => action.kind === 'next')?.label, 'Continue');
  assert.deepEqual(inspection.pauseReasons.sort(), ['captcha', 'file_upload']);
});

test('validates required fields and captures final answers for learning', () => {
  const document = makeDocument(`
    <form><label for="name">Full Name</label><input id="name" value="Nithin" required>
      <label for="salary">Expected CTC</label><input id="salary" value="6000000">
      <button type="submit">Submit application</button></form>
  `);
  const validation = validateDocument(document);
  assert.equal(validation.ok, true);
  const records = collectAnswerRecords(document);
  assert.deepEqual(records.map(({ key, answer, sensitivity }) => ({ key, answer, sensitivity })), [
    { key: 'full_name', answer: 'Nithin', sensitivity: 'safe' },
    { key: 'expected_ctc', answer: '6000000', sensitivity: 'review' },
  ]);
});

test('classifies a submit-type Next button as navigation and submits only through the final action', () => {
  const document = makeDocument(`
    <form><input name="name" value="Nithin"><button>Next</button></form>
  `);
  const inspection = inspectDocument(document);
  assert.equal(inspection.actions[0].kind, 'next');
});
