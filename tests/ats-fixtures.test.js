import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { seedDatasource } from '../src/datasource.js';
import { applyDecisions, collectAnswerRecords, collectFieldDescriptors, inspectDocument, planDeterministicFill, clickAction, waitForDocumentSettled } from '../src/form-engine.js';

async function fixture(name) {
  return new JSDOM(await readFile(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8'), { url: `https://${name}.example/apply` });
}

test('bundled profile links fill through discovery and readback without submitting or overwriting', async () => {
  const seed = JSON.parse(await readFile(new URL('../data/seed-data.json', import.meta.url), 'utf8'));
  for (const githubLabel of ['GitHub URL', 'GitHub Profile URL', 'Please provide your GitHub profile link']) {
    const dom = new JSDOM(`<form aria-label="Job application">
      <label>${githubLabel}<input id="github" type="url"></label>
      <label>LinkedIn Profile<input id="linkedin" type="url" required></label>
      <label>Resume/CV<input type="file" required></label>
      <button type="submit">Submit application</button></form>`, { url: 'https://application.example/apply' });
    try {
      const document = dom.window.document;
      let submitted = false;
      document.querySelector('form').addEventListener('submit', event => { submitted = true; event.preventDefault(); });
      const records = seedDatasource(seed).answerRecords;
      const fill = () => applyDecisions(document, planDeterministicFill(collectFieldDescriptors(document), records));
      const result = await fill();
      assert.equal(result.applied.length, 2);
      for (const key of ['github', 'linkedin']) {
        assert.equal(document.getElementById(key).value, records.find(record => record.key === key).answer);
      }
      document.getElementById('github').value = 'https://github.com/user-edited';
      await fill();
      assert.equal(document.getElementById('github').value, 'https://github.com/user-edited');
      assert.equal(document.querySelector('input[type="file"]').value, '');
      assert.equal(submitted, false);
    } finally { dom.window.close(); }
  }
});

test('Workday fixture preserves repeated employment and waits for delayed education controls', async () => {
  const dom = await fixture('workday');
  const document = dom.window.document;
  const records = collectAnswerRecords(document);
  assert.deepEqual(records.filter((record) => record.question === 'Company').map((record) => record.answer), ['Analytical Engines', 'Ada Computing']);
  assert.equal(records.find((record) => record.question === 'Have you previously worked here?').answer, 'No');
  const plan = planDeterministicFill(collectFieldDescriptors(document), records);
  assert.deepEqual(plan.filter((decision) => decision.value?.includes('Comput')).map((decision) => decision.value), ['Ada Computing']);
  document.querySelector('button').addEventListener('click', () => {
    setTimeout(() => { document.querySelector('form').innerHTML = '<h2>Education</h2>'; }, 30);
    setTimeout(() => { document.querySelector('form').insertAdjacentHTML('beforeend', '<fieldset id="education1"><legend>Education</legend><label>School<input id="school"></label></fieldset>'); }, 100);
  });
  assert.equal(clickAction(document, inspectDocument(document).actions[0].id).ok, true);
  await waitForDocumentSettled(document, { quietMs: 40, minWaitMs: 160, timeoutMs: 600 });
  assert.equal(collectFieldDescriptors(document)[0].entityType, 'education');
  dom.window.close();
});

test('Workday address labels keep numbered and local-script fields isolated', async () => {
  const dom = new JSDOM(`<form aria-label="My Information">
    <label>Address Line 1 - Local<input id="address--addressLine1Local"></label>
    <label>Address Line 2 - Local<input id="address--addressLine2Local"></label>
    <label>City - Local<input id="address--cityLocal"></label>
    <label>Street<input id="address--addressLine1"></label>
    <label>Address Line 2<input id="address--addressLine2" value="Existing line 2"></label>
    <label>Line 3<input id="address--addressLine3"></label>
    <label>Locality<input id="address--city"></label>
    <label>Postcode<input id="address--postalCode"></label>
    <label>State or Territory<select id="address--state"><option value="">Select a state</option><option>Maharashtra</option><option>Delhi</option></select></label>
  </form>`, { url: 'https://workday.example/apply' });
  const document = dom.window.document;
  const records = [
    { key: 'address_line_1', question: 'Street address', answer: '12 Oak Road' },
    { key: 'address_line_2', question: 'Address Line 2', answer: 'Apartment 4' },
    { key: 'city', question: 'City', answer: 'Pune' },
    { key: 'postal_code', question: 'Postal code', answer: '411001' },
    { key: 'state', question: 'State', answer: 'Maharashtra' },
  ].map((record) => ({ ...record, sensitivity: 'safe', confirmationState: 'confirmed' }));
  const decisions = planDeterministicFill(collectFieldDescriptors(document), records);
  assert.equal(decisions.find((decision) => decision.fieldId === 'address--addressLine1').value, '12 Oak Road');
  assert.equal(decisions.find((decision) => decision.fieldId === 'address--addressLine2').value, 'Apartment 4');
  assert.equal(decisions.find((decision) => decision.fieldId === 'address--city').value, 'Pune');
  assert.equal(decisions.find((decision) => decision.fieldId === 'address--postalCode').value, '411001');
  for (const id of ['address--addressLine1Local', 'address--addressLine2Local', 'address--cityLocal', 'address--addressLine3']) {
    assert.equal(decisions.find((decision) => decision.fieldId === id).action, 'ask_user');
  }
  const result = await applyDecisions(document, decisions);
  assert.equal(document.getElementById('address--addressLine1').value, '12 Oak Road');
  assert.equal(document.getElementById('address--addressLine2').value, 'Existing line 2');
  assert.equal(document.getElementById('address--city').value, 'Pune');
  assert.equal(document.getElementById('address--postalCode').value, '411001');
  assert.equal(document.getElementById('address--state').value, 'Maharashtra');
  assert.equal(document.getElementById('address--addressLine3').value, '');
  assert.equal(document.getElementById('address--addressLine1Local').value, '');
  assert.equal(document.getElementById('address--addressLine2Local').value, '');
  assert.equal(document.getElementById('address--cityLocal').value, '');
  assert.equal(result.failed.length, 0);
  dom.window.close();
});

test('Lever fixture fills only the application and preserves URL purpose and multiple skills', async () => {
  const dom = await fixture('lever');
  const document = dom.window.document;
  const records = [
    { key: 'full_name', answer: 'Ada Lovelace' }, { key: 'email', answer: 'ada@example.com' },
    { key: 'github', answer: 'https://github.com/example' }, { key: 'linkedin', answer: 'https://linkedin.com/in/example' },
    { key: 'skills', answer: 'JavaScript, Python' },
  ].map((record) => ({ ...record, sensitivity: 'safe', confirmationState: 'confirmed' }));
  const result = await applyDecisions(document, planDeterministicFill(collectFieldDescriptors(document), records));
  assert.equal(result.applied.length, 5);
  assert.equal(document.querySelector('#subscribe-email').value, '');
  assert.equal(document.querySelector('[name="urls[GitHub]"]').value, 'https://github.com/example');
  assert.equal(collectAnswerRecords(document).find((record) => record.question === 'Skills').answer, 'JavaScript, Python');
  assert.equal(result.failed.length, 0);
  dom.window.close();
});

test('Ashby fixture commits delayed searchable and multiple-selection options', async () => {
  const dom = await fixture('ashby');
  const document = dom.window.document;
  const input = document.querySelector('#location');
  input.addEventListener('input', () => {
    if (input.value !== 'London' || document.querySelector('#locations [role="option"]')) return;
    input.setAttribute('aria-expanded', 'true');
    setTimeout(() => {
      const list = document.querySelector('#locations');
      list.hidden = false;
      list.innerHTML = '<div role="option" aria-selected="false">London</div>';
      list.firstElementChild.addEventListener('click', () => {
        list.firstElementChild.setAttribute('aria-selected', 'true');
        input.value = 'London';
        input.setAttribute('aria-expanded', 'false');
        list.hidden = true;
      });
    }, 40);
  });
  const languages = document.querySelector('#languages');
  languages.addEventListener('click', () => { document.querySelector('#language-options').hidden = false; });
  for (const option of document.querySelectorAll('#language-options [role="option"]')) option.addEventListener('click', () => {
    option.setAttribute('aria-selected', 'true');
    languages.textContent = [...document.querySelectorAll('#language-options [aria-selected="true"]')].map((item) => item.textContent).join(', ');
  });
  const result = await applyDecisions(document, planDeterministicFill(collectFieldDescriptors(document), [
    { key: 'location', answer: 'London', sensitivity: 'safe', confirmationState: 'confirmed' }, { key: 'languages', answer: 'English, French', sensitivity: 'safe', confirmationState: 'confirmed' },
  ]));
  assert.equal(result.applied.length, 2);
  assert.equal(result.unresolved.length, 0);
  assert.equal(collectAnswerRecords(document).find((record) => record.question === 'Languages').answer, 'English, French');
  dom.window.close();
});
