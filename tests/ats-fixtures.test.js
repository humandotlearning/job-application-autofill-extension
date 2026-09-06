import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { applyDecisions, collectAnswerRecords, collectFieldDescriptors, inspectDocument, planDeterministicFill, clickAction, waitForDocumentSettled } from '../src/form-engine.js';

async function fixture(name) {
  return new JSDOM(await readFile(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8'), { url: `https://${name}.example/apply` });
}

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

test('Lever fixture fills only the application and preserves URL purpose and multiple skills', async () => {
  const dom = await fixture('lever');
  const document = dom.window.document;
  const records = [
    { key: 'full_name', answer: 'Ada Lovelace' }, { key: 'email', answer: 'ada@example.com' },
    { key: 'github', answer: 'https://github.com/example' }, { key: 'linkedin', answer: 'https://linkedin.com/in/example' },
    { key: 'skills', answer: 'JavaScript, Python' },
  ].map((record) => ({ ...record, sensitivity: 'safe' }));
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
    { key: 'location', answer: 'London', sensitivity: 'safe' }, { key: 'languages', answer: 'English, French', sensitivity: 'safe' },
  ]));
  assert.equal(result.applied.length, 2);
  assert.equal(result.unresolved.length, 0);
  assert.equal(collectAnswerRecords(document).find((record) => record.question === 'Languages').answer, 'English, French');
  dom.window.close();
});
