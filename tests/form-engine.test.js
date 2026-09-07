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

test('tolerates browser invalid-regexp errors from third-party pattern attributes', () => {
  const document = makeDocument(`
    <form>
      <label for="email">Email</label>
      <input id="email" type="email" value="ada@example.com">
    </form>
  `);
  const input = document.querySelector('#email');
  input.setAttribute('pattern', '[a-z-]+');
  const nativeCheckValidity = input.checkValidity.bind(input);
  input.checkValidity = () => {
    if (input.hasAttribute('pattern')) throw new SyntaxError('Invalid regular expression in pattern');
    return nativeCheckValidity();
  };

  assert.doesNotThrow(() => validateDocument(document));
  assert.equal(validateDocument(document).ok, true);
  assert.equal(input.getAttribute('pattern'), '[a-z-]+');
});

test('preflights invalid HTML patterns before native validation can log an error', () => {
  const document = makeDocument('<form><label for="email">Email</label><input id="email" type="email" required value="ada@example.com"></form>');
  const input = document.querySelector('#email');
  // Legacy character classes can compile without flags but fail HTML's v mode.
  const pattern = '[a-z-]+@[a-z.-]+';
  assert.doesNotThrow(() => new RegExp(pattern));
  assert.throws(() => new RegExp(pattern, 'v'), SyntaxError);
  input.setAttribute('pattern', pattern);
  const nativeCheckValidity = input.checkValidity.bind(input);
  let checksWithInvalidPattern = 0;
  input.checkValidity = () => {
    // Chrome can report a bad pattern without throwing to the caller.
    if (input.hasAttribute('pattern')) checksWithInvalidPattern += 1;
    return nativeCheckValidity();
  };
  assert.equal(validateDocument(document).ok, true);
  assert.equal(collectAnswerRecords(document).length, 1);
  assert.equal(checksWithInvalidPattern, 0);
  assert.equal(input.getAttribute('pattern'), pattern);

  input.value = 'not-an-email';
  assert.equal(validateDocument(document).ok, false);
  assert.equal(collectAnswerRecords(document).length, 0);
  input.value = '';
  assert.equal(validateDocument(document).ok, false);
  input.value = 'ada@example.com';
  input.setCustomValidity('This email is already registered');
  assert.equal(validateDocument(document).ok, false);
  assert.equal(checksWithInvalidPattern, 0);
  assert.equal(input.getAttribute('pattern'), pattern);
});

test('valid patterns remain present and enforced during native validation', () => {
  const document = makeDocument('<form><label for="code">Code</label><input id="code" pattern="[A-Z]{3}" value="ABC"></form>');
  const input = document.querySelector('#code');
  const nativeCheckValidity = input.checkValidity.bind(input);
  input.checkValidity = () => {
    assert.equal(input.getAttribute('pattern'), '[A-Z]{3}');
    return nativeCheckValidity();
  };
  assert.equal(validateDocument(document).ok, true);
  input.value = '123';
  assert.equal(validateDocument(document).ok, false);
});

test('restores an invalid pattern even if another native validation error occurs', () => {
  const document = makeDocument('<form><input id="code" pattern="[" value="ABC"></form>');
  const input = document.querySelector('#code');
  input.checkValidity = () => {
    assert.equal(input.hasAttribute('pattern'), false);
    throw new Error('Unexpected validation failure');
  };
  assert.throws(() => validateDocument(document), /Unexpected validation failure/);
  assert.equal(input.getAttribute('pattern'), '[');
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

test('reads the selected radio option instead of only the first radio element', () => {
  const document = makeDocument(`
    <fieldset><legend>Authorized to work?</legend>
      <label><input type="radio" name="authorized" value="Yes">Yes</label>
      <label><input type="radio" name="authorized" value="No" checked>No</label>
    </fieldset>
  `);
  assert.equal(collectFieldDescriptors(document)[0].currentValue, 'No');
  assert.deepEqual(collectAnswerRecords(document).map((record) => record.answer), ['No']);
});

test('distinguishes an explicit unchecked checkbox from an untouched checkbox', async () => {
  const document = makeDocument('<label><input id="consent" type="checkbox">Consent</label>');
  const field = collectFieldDescriptors(document)[0];
  assert.equal(field.currentValue, '');
  const result = await applyDecisions(document, [{
    fieldId: field.id,
    action: 'fill',
    value: 'No',
    evidenceKeys: ['consent'],
    confidence: 'high',
    sensitivity: 'legal',
    reason: 'Known negative answer',
  }]);
  assert.equal(result.applied.length, 1);
  assert.equal(collectFieldDescriptors(document)[0].currentValue, 'No');
});

test('fills an anonymous native input without throwing', async () => {
  const document = makeDocument('<label>Email<input type="email"></label>');
  const field = collectFieldDescriptors(document)[0];
  const result = await applyDecisions(document, [{
    fieldId: field.id,
    action: 'fill',
    value: 'ada@example.com',
    evidenceKeys: ['email'],
    confidence: 'high',
    sensitivity: 'safe',
    reason: 'Known email',
  }]);
  assert.equal(result.applied.length, 1);
  assert.equal(document.querySelector('input').value, 'ada@example.com');
});

test('marks extension fills as provisional until the applicant edits the value', async () => {
  const document = makeDocument('<label>Email<input type="email"></label>');
  const field = collectFieldDescriptors(document)[0];
  await applyDecisions(document, [{
    fieldId: field.id,
    action: 'fill',
    value: 'ada@example.com',
    evidenceKeys: ['email'],
    confidence: 'high',
    sensitivity: 'safe',
    reason: 'Known email',
  }]);
  assert.equal(collectAnswerRecords(document)[0].provenance, 'autofill');
  const input = document.querySelector('input');
  input.value = 'ada.changed@example.com';
  input.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
  assert.equal(collectAnswerRecords(document)[0].provenance, 'user');
});

test('reads a populated input combobox as its committed value', () => {
  const document = makeDocument('<main><label for="city">City</label><input id="city" role="combobox" value="London" aria-label="City"></main>');
  const field = collectFieldDescriptors(document)[0];
  assert.equal(field.type, 'select');
  assert.equal(field.currentValue, 'London');
  assert.equal(collectAnswerRecords(document)[0].answer, 'London');
});

test('keeps repeated same-label entries as distinct learned records', () => {
  const document = makeDocument(`
    <form><label>Company<input name="company" value="Analytical Engines"></label></form>
    <form><label>Company<input name="company" value="Ada Computing"></label></form>
  `);
  const records = collectAnswerRecords(document);
  assert.equal(records.length, 2);
  assert.notEqual(records[0].key, records[1].key);
});

test('keeps repeated entry identity when an earlier entry is empty', () => {
  const document = makeDocument('<fieldset><legend>Employment</legend><label>Company<input name="company"></label><label>Company<input name="company" value="Second"></label></fieldset>');
  const before = collectAnswerRecords(document)[0];
  document.querySelector('input').value = 'First';
  const after = collectAnswerRecords(document).find((record) => record.answer === 'Second');
  assert.equal(before.key, after.key);
  assert.equal(before.entityId, after.entityId);
});

test('rejects stale handles when a control is replaced', async () => {
  const document = makeDocument('<label>Email<input id="email" type="email"></label>');
  const decisions = planDeterministicFill(collectFieldDescriptors(document), [{ key: 'email', answer: 'ada@example.com', sensitivity: 'safe' }]);
  const old = document.querySelector('input');
  old.replaceWith(old.cloneNode());
  const result = await applyDecisions(document, decisions);
  assert.equal(document.querySelector('input').value, '');
  assert.equal(result.failed.length, 1);
});

test('selects the application form and excludes a subscription form', () => {
  const document = makeDocument('<form aria-label="Subscribe"><label>Email<input type="email" id="subscription"></label><button>Subscribe</button></form><form aria-label="Job application"><label>Full name<input id="candidate"></label><button>Submit application</button></form>');
  const inspection = inspectDocument(document);
  assert.deepEqual(inspection.fields.map((field) => field.id), ['candidate']);
  assert.deepEqual(inspection.actions.map((action) => action.label), ['Submit application']);
});

test('ambiguous application forms require a focused form before extraction', () => {
  const document = makeDocument('<form aria-label="Job application"><label>Name<input id="one"></label></form><form aria-label="Job application"><label>Name<input id="two"></label></form>');
  assert.equal(collectFieldDescriptors(document).length, 0);
  document.querySelector('#two').focus();
  assert.deepEqual(collectFieldDescriptors(document).map((field) => field.id), ['two']);
});

test('application validation respects framework aria-invalid errors', () => {
  const document = makeDocument('<label>Email<input id="email" type="email" value="ada@example.com" aria-invalid="true"></label>');
  assert.equal(validateDocument(document).ok, false);
  assert.equal(collectAnswerRecords(document).length, 0);
});

test('does not treat a combobox highlighted option as a committed value', () => {
  const document = makeDocument('<main><input role="combobox" aria-label="City" aria-expanded="true" aria-controls="cities" aria-activedescendant="london"><div id="cities" role="listbox"><div id="london" role="option">London</div></div></main>');
  assert.equal(collectFieldDescriptors(document)[0].currentValue, '');
});

test('requires a committed searchable dropdown selection', async () => {
  const document = makeDocument('<form><div><input id="country" role="combobox" aria-label="Country" aria-autocomplete="list" aria-controls="countries"><div role="listbox" id="countries"><div role="option" aria-selected="false">India</div></div></div></form>');
  const result = await applyDecisions(document, planDeterministicFill(collectFieldDescriptors(document), [{ key: 'country', answer: 'India', sensitivity: 'safe' }]));
  assert.equal(result.applied.length, 0);
  assert.equal(collectAnswerRecords(document).length, 0);
});

test('does not steal options when its controlled popup is missing', async () => {
  const document = makeDocument('<form><button type="button" role="combobox" aria-label="Country" aria-controls="missing">Select one</button><div role="listbox" id="unrelated"><div role="option" aria-selected="true">India</div></div></form>');
  assert.equal(collectFieldDescriptors(document)[0].currentValue, '');
  assert.deepEqual(collectFieldDescriptors(document)[0].options, []);
});

test('composes full names locally from unambiguous name parts', () => {
  const document = makeDocument('<label>Name<input id="name"></label>');
  const decisions = planDeterministicFill(collectFieldDescriptors(document), [
    { key: 'first_name', answer: 'Ada', sensitivity: 'safe' }, { key: 'last_name', answer: 'Lovelace', sensitivity: 'safe' },
  ]);
  assert.equal(decisions[0].value, 'Ada Lovelace');
  assert.equal(decisions[0].transformation, 'compose_name');
});

test('round trips repeated employers with their original entity IDs', () => {
  const document = makeDocument('<form><fieldset id="job1"><legend>Employment</legend><label>Company<input value="Acme"></label></fieldset><fieldset id="job2"><legend>Employment</legend><label>Company<input value="Other"></label></fieldset></form>');
  const records = collectAnswerRecords(document);
  assert.deepEqual(records.map((record) => record.entityId), ['job1', 'job2']);
  const decisions = planDeterministicFill(collectFieldDescriptors(document), records);
  assert.deepEqual(decisions.map((decision) => decision.value), ['Acme', 'Other']);
});

test('round trips all native multiple selections', async () => {
  const document = makeDocument('<label>Skills<select multiple id="skills"><option>Java</option><option>Python</option></select></label>');
  const decisions = planDeterministicFill(collectFieldDescriptors(document), [{ key: 'skills', answer: 'Java, Python', sensitivity: 'safe' }]);
  const result = await applyDecisions(document, decisions);
  assert.equal(result.applied.length, 1);
  assert.equal(collectAnswerRecords(document)[0].answer, 'Java, Python');
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

test('uses company defaults only for clearly identified employer relationship questions', () => {
  const profile = {
    employment: [{ id: 'deepsight-ai-labs', company: 'DeepSight AI Labs' }],
    defaults: { relatedToHiringCompany: 'No', knownAtHiringCompany: 'No' },
  };
  const fields = [
    { id: 'worked', label: 'Have you worked for this company?', targetCompany: 'Other Co', type: 'radio', options: ['Yes', 'No'] },
    { id: 'relative', label: 'Do you have a relative at this company?', targetCompany: 'Other Co', type: 'radio', options: ['Yes', 'No'] },
    { id: 'referral', label: 'Were you referred by a colleague?', targetCompany: 'Other Co', type: 'radio', options: ['Yes', 'No'] },
    { id: 'prior', label: 'Have you worked for this company?', targetCompany: 'DeepSight AI Labs', type: 'radio', options: ['Yes', 'No'] },
  ];
  const decisions = planDeterministicFill(fields, [], [], profile);
  assert.deepEqual(decisions.map((decision) => decision.value), ['No', 'No', null, 'Yes']);
  assert.equal(decisions[2].action, 'ask_user');
});
