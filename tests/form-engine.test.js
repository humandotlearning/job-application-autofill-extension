import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  applyDecisions,
  collectAnswerRecords,
  collectFieldDescriptors,
  focusField,
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
  assert.deepEqual(fields[1].options, ['Choose', 'India', 'IN']);
});

test('ignores fields and pause markers inside hidden steps', () => {
  const document = makeDocument(`
    <form><label for="visible">Visible name</label><input id="visible"></form>
    <form hidden><label for="hidden">Hidden name</label><input id="hidden"><p>CAPTCHA</p></form>
    <form class="css-hidden"><label for="styled">Styled hidden</label><input id="styled"></form>
    <input id="pwd-hint" name="passwordHint" type="text"><input autocomplete="current-password" type="text">
  `);
  const style = document.createElement('style');
  style.textContent = '.css-hidden { display: none; }';
  document.head.append(style);
  const inspection = inspectDocument(document);
  assert.deepEqual(inspection.fields.map((field) => field.id), ['visible']);
  assert.deepEqual(inspection.pauseReasons, []);
});

test('discovers selected custom listbox fields but ignores utility menus', () => {
  const document = makeDocument(`
    <button id="language" aria-haspopup="listbox">English</button>
    <main>
      <div>
        <span>Country</span>
        <button id="country" name="country" aria-haspopup="listbox" aria-label="Country India Required">India</button>
        <input type="text" value="country-id" aria-hidden="true">
      </div>
    </main>
  `);
  const inspection = inspectDocument(document);
  assert.deepEqual(inspection.fields.map((field) => field.id), ['country']);
  assert.equal(inspection.fields[0].type, 'select');
  assert.equal(inspection.fields[0].label, 'Country');
  assert.equal(inspection.fields[0].currentValue, 'India');
  assert.deepEqual(inspection.pauseReasons, []);
  assert.deepEqual(collectAnswerRecords(document).map(({ key, answer }) => ({ key, answer })), [
    { key: 'country', answer: 'India' },
  ]);
});

test('prefers the nearby Workday question label over a placeholder aria-label for custom widgets', () => {
  const document = makeDocument(`
    <form>
      <fieldset>
        <legend>Highest Level of Education</legend>
        <div class="workday-field">
          <button id="education" name="education" aria-haspopup="listbox" aria-label="Select One Required">Select One</button>
          <input type="text" value="" aria-hidden="true">
        </div>
      </fieldset>
    </form>
  `);

  const fields = collectFieldDescriptors(document);

  assert.equal(fields[0].id, 'education');
  assert.equal(fields[0].label, 'Highest Level of Education');
});

test('extracts an associated Workday label before its verbose button aria-label', () => {
  const document = makeDocument(`
    <form>
      <label for="degree">Degree</label>
      <button id="degree" name="degree" aria-haspopup="listbox" aria-label="Degree University or College Diploma; Undergraduate or Bachelor’s Degree Required">Select One</button>
      <input type="text" value="" aria-hidden="true">
    </form>
  `);
  const field = collectFieldDescriptors(document)[0];
  assert.equal(field.label, 'Degree');
  assert.equal(field.currentValue, '');
});

test('pauses for an empty required custom choice field', () => {
  const document = makeDocument(`
    <main>
      <button id="previous-worker" name="previousWorker" aria-haspopup="listbox" aria-label="Have you worked here? Required">Select One</button>
      <input type="text" value="" aria-hidden="true">
    </main>
  `);
  const inspection = inspectDocument(document);
  const validation = validateDocument(document);
  assert.equal(inspection.pauseReasons.includes('unsupported_widget'), true);
  assert.equal(validation.ok, false);
  assert.deepEqual(validation.requiredEmpty.map((field) => field.fieldId), ['previous-worker']);
});

test('selects an exact option from a generic custom listbox after delayed rendering', async () => {
  const document = makeDocument(`
    <main>
      <button type="button" id="country" name="country" aria-haspopup="listbox" aria-label="Country Required">Choose country</button>
      <input type="text" value="" aria-hidden="true">
    </main>
  `);
  const button = document.querySelector('#country');
  button.addEventListener('click', () => {
    setTimeout(() => {
      const listbox = document.createElement('div');
      listbox.setAttribute('role', 'listbox');
      const option = document.createElement('div');
      option.setAttribute('role', 'option');
      option.textContent = 'India';
      option.addEventListener('click', () => {
        button.textContent = 'India';
        listbox.remove();
      });
      listbox.append(option);
      document.body.append(listbox);
    }, 10);
  });

  const field = inspectDocument(document).fields[0];
  const result = await applyDecisions(document, [{
    fieldId: field.id,
    action: 'fill',
    value: 'India',
    evidenceKeys: ['country'],
    confidence: 'high',
    sensitivity: 'safe',
    reason: 'Known country',
  }]);

  assert.equal(result.failed.length, 0);
  assert.equal(result.applied.length, 1);
  assert.equal(document.querySelector('#country').textContent, 'India');
});

test('applies to an accessible custom choice without an id or name', async () => {
  const document = makeDocument(`
    <main><button type="button" aria-haspopup="listbox" aria-label="Country Required">Choose country</button></main>
  `);
  const button = document.querySelector('button');
  button.addEventListener('click', () => {
    const listbox = document.createElement('div');
    listbox.setAttribute('role', 'listbox');
    const option = document.createElement('div');
    option.setAttribute('role', 'option');
    option.textContent = 'India';
    option.addEventListener('click', () => {
      button.textContent = 'India';
      listbox.remove();
    });
    listbox.append(option);
    document.body.append(listbox);
  });

  const field = inspectDocument(document).fields[0];
  const result = await applyDecisions(document, [{
    fieldId: field.id,
    action: 'fill',
    value: 'India',
    evidenceKeys: ['country'],
    confidence: 'high',
    sensitivity: 'safe',
    reason: 'Known country',
  }]);

  assert.equal(result.failed.length, 0);
  assert.equal(result.applied.length, 1);
  assert.equal(button.textContent, 'India');
});

async function runCustomFailureScenario(html, attach, fieldId, reason) {
  const document = makeDocument(html);
  attach(document);
  const field = collectFieldDescriptors(document).find((candidate) => candidate.id === fieldId);
  const result = await applyDecisions(document, [{
    fieldId: field.id,
    action: 'fill',
    value: 'India',
    evidenceKeys: [fieldId],
    confidence: 'high',
    sensitivity: 'safe',
    reason: 'Known country',
  }]);
  assert.equal(result.applied.length, 0);
  assert.equal(result.failed.length, 0);
  assert.deepEqual(result.unresolved.map(({ reason: actualReason }) => actualReason), [reason]);
}

test('returns unresolved when a custom widget exposes duplicate exact options', async () => {
  await runCustomFailureScenario(`
    <form>
      <button type="button" id="ambiguous" name="ambiguous" aria-haspopup="listbox" aria-label="Ambiguous Required">Choose one</button>
      <input type="text" value="" aria-hidden="true">
    </form>
  `, (document) => {
    document.querySelector('#ambiguous').addEventListener('click', () => {
      const listbox = document.createElement('div');
      listbox.setAttribute('role', 'listbox');
      for (const text of ['India', 'India']) {
        const option = document.createElement('div');
        option.setAttribute('role', 'option');
        option.textContent = text;
        listbox.append(option);
      }
      document.body.append(listbox);
    });
  }, 'ambiguous', 'The custom widget does not expose one unique exact option');
});

test('returns unresolved when a custom widget never reveals options', async () => {
  await runCustomFailureScenario(`
    <form>
      <button type="button" id="unavailable" name="unavailable" aria-haspopup="listbox" aria-label="Unavailable Required">Choose one</button>
      <input type="text" value="" aria-hidden="true">
    </form>
  `, (document) => {
    document.querySelector('#unavailable').addEventListener('click', () => {});
  }, 'unavailable', 'The custom widget did not reveal any options');
});

test('returns unresolved when a custom widget rejects the selected option', async () => {
  await runCustomFailureScenario(`
    <form>
      <button type="button" id="rejected" name="rejected" aria-haspopup="listbox" aria-label="Rejected Required">Choose one</button>
      <input type="text" value="" aria-hidden="true">
    </form>
  `, (document) => {
    document.querySelector('#rejected').addEventListener('click', () => {
      const listbox = document.createElement('div');
      listbox.setAttribute('role', 'listbox');
      const option = document.createElement('div');
      option.setAttribute('role', 'option');
      option.textContent = 'India';
      option.addEventListener('click', () => {});
      listbox.append(option);
      document.body.append(listbox);
    });
  }, 'rejected', 'The custom widget did not accept the selected option');
});

test('keeps native fill failures in failed', async () => {
  const document = makeDocument(`
    <form>
      <label for="email">Email</label><input id="email" type="email">
    </form>
  `);

  const field = collectFieldDescriptors(document)[0];
  const result = await applyDecisions(document, [{
    fieldId: field.id,
    action: 'fill',
    value: 'not-an-email',
    evidenceKeys: ['email'],
    confidence: 'high',
    sensitivity: 'safe',
    reason: 'Known email',
  }]);

  assert.equal(result.applied.length, 0);
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].reason, /valid email/i);
});

test('does not reuse an unrelated ancestor label for a custom widget', () => {
  const document = makeDocument(`
    <form>
      <div class="layout">
        <label for="other">Other field</label>
        <input id="other" value="value">
        <div class="question">
          <button type="button" id="education" name="education" aria-haspopup="listbox" aria-label="Select One Required">Select One</button>
          <input type="text" value="" aria-hidden="true">
        </div>
      </div>
    </form>
  `);

  const fields = collectFieldDescriptors(document);

  assert.equal(fields[0].id, 'other');
  assert.equal(fields[1].id, 'education');
  assert.equal(fields[1].label, 'education');
});

test('does not use a custom widget prompt as its question label', () => {
  const document = makeDocument(`
    <main>
      <button id="authorization" name="workAuthorization" aria-haspopup="listbox" aria-label="Select One Required">Select One</button>
      <input type="text" value="" aria-hidden="true">
    </main>
  `);
  const field = collectFieldDescriptors(document)[0];
  assert.equal(field.label, 'workAuthorization');
  assert.equal(field.currentValue, '');
});

test('fills deterministic safe matches and preserves valid existing values', async () => {
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
  const result = await applyDecisions(document, decisions);
  assert.equal(document.querySelector('#name').value, 'Nithin Varghese');
  assert.equal(document.querySelector('#email').value, 'existing@example.com');
  assert.equal(changes, 1);
  assert.equal(result.applied.length, 1);
  assert.equal(result.kept.length, 1);
});

test('matches spaced brand labels when the field uses a generated id', () => {
  const document = makeDocument(`
    <form>
      <label for="936e4371-8d8e-4c19-9be7-845898b93bb0">Linked In Profile:</label>
      <input id="936e4371-8d8e-4c19-9be7-845898b93bb0" required>
    </form>
  `);
  const records = [{
    key: 'linkedin',
    question: 'LinkedIn',
    answer: 'https://www.linkedin.com/in/nithin1357',
    aliases: ['LinkedIn'],
    sensitivity: 'safe',
    type: 'url',
  }];

  const decisions = planDeterministicFill(collectFieldDescriptors(document), records);

  assert.equal(decisions[0].action, 'fill');
  assert.equal(decisions[0].value, 'https://www.linkedin.com/in/nithin1357');
});

test('applies select, radio, and checkbox decisions only when options validate', async () => {
  const document = makeDocument(`
    <form>
      <label for="country">Country</label><select id="country"><option value="">Choose</option><option value="IN">India</option></select>
      <fieldset><legend>Willing to relocate?</legend><label><input type="radio" name="relocate" value="Yes">Yes</label><label><input type="radio" name="relocate" value="No">No</label></fieldset>
      <label><input id="consent" type="checkbox"> I agree</label>
    </form>
  `);
  const fields = collectFieldDescriptors(document);
  const result = await applyDecisions(document, fields.map((field) => ({
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

test('promotes inferred sensitive fields to final review even when a record says safe', async () => {
  const document = makeDocument('<label for="salary">Expected CTC</label><input id="salary">');
  const result = await applyDecisions(document, [{
    fieldId: 'salary',
    action: 'fill',
    value: '5000000',
    evidenceKeys: ['salary'],
    confidence: 'high',
    sensitivity: 'safe',
    reason: 'Known value',
  }]);
  assert.equal(result.applied.length, 1);
  assert.equal(result.reviewRequired[0].sensitivity, 'review');
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

test('classifies a submit-type Next button as navigation without submitting it', () => {
  const document = makeDocument(`
    <form><input name="name" value="Nithin"><button>Next</button></form>
  `);
  const inspection = inspectDocument(document);
  assert.equal(inspection.actions[0].kind, 'next');
});

test('focuses a matching field without changing its value', () => {
  const document = makeDocument('<form><label for="name">Full name</label><input id="name" value="Nithin"></form>');
  assert.equal(focusField(document, 'name'), true);
  assert.equal(document.querySelector('#name').value, 'Nithin');
  assert.equal(document.activeElement.id, 'name');
});
