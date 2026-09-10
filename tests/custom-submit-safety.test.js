import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { applyDecisions, collectFieldDescriptors } from '../src/form-engine.js';

function fixture(type = 'type="button"', wrapper = 'form', option = '<div role="option">India</div>') {
  const document = new JSDOM(`<${wrapper}><label id="country-label" for="country">Country</label><button ${type} id="country" role="combobox" aria-labelledby="country-label" aria-controls="countries">Select one</button><div id="countries" role="listbox">${option}</div></${wrapper}>`, { url: 'https://jobs.example.com/apply' }).window.document;
  const button = document.getElementById('country');
  const events = { submit: 0, reset: 0 };
  for (const name of Object.keys(events)) document.addEventListener(name, (event) => { events[name] += 1; event.preventDefault(); });
  document.querySelector('[role="option"]').onclick = () => { button.textContent = 'India'; };
  return { document, button, events };
}

for (const type of ['submit', 'reset']) {
  test(`rechecks trigger type after focus changes it to ${type}`, async () => {
    const { document, button, events } = fixture();
    button.onfocus = () => { button.type = type; };
    const result = await fill(document);
    assert.deepEqual(events, { submit: 0, reset: 0 });
    assert.equal(result.applied.length, 0);
  });
}

for (const option of ['<button role="option">India</button>', '<button type="reset" role="option">India</button>', '<input type="image" role="option" aria-label="India">']) {
  test(`does not activate a native form action option: ${option}`, async () => {
    const { document, events } = fixture('type="button"', 'form', option);
    let clicks = 0;
    document.querySelector('[role="option"]').addEventListener('click', () => { clicks += 1; });
    const result = await fill(document);
    assert.deepEqual(events, { submit: 0, reset: 0 });
    assert.equal(clicks, 0);
    assert.equal(result.applied.length, 0);
  });
}

test('rechecks each option after the preceding selection changes its native type', async () => {
  const { document, button, events } = fixture('type="button"', 'form', '<button type="button" role="option">India</button><button type="button" role="option">Canada</button>');
  button.setAttribute('aria-multiselectable', 'true');
  const [first, second] = document.querySelectorAll('[role="option"]');
  first.onclick = () => { second.type = 'submit'; };
  await applyDecisions(document, [{ fieldId: 'country', action: 'fill', value: 'India, Canada', approved: true }]);
  assert.deepEqual(events, { submit: 0, reset: 0 });
});

test('excludes externally form-associated and image custom triggers', async () => {
  for (const markup of ['<button form="application" role="combobox" id="country" aria-label="Country">Select one</button>', '<input form="application" type="image" role="combobox" id="country" aria-label="Country">']) {
    const document = new JSDOM(`<main><form id="application"></form>${markup}</main>`).window.document;
    assert.equal(collectFieldDescriptors(document).length, 0);
  }
});

async function fill(document) {
  return applyDecisions(document, [{ fieldId: 'country', action: 'fill', value: 'India', approved: true }]);
}

for (const type of ['', 'type="submit"', 'type="reset"', 'type="invalid"']) {
  test(`rejects form-associated custom button (${type || 'omitted type'}) without submission/reset`, async () => {
    const { document, events } = fixture(type);
    const fields = collectFieldDescriptors(document);
    await fill(document);
    assert.deepEqual(events, { submit: 0, reset: 0 });
    assert.equal(fields.length, 0);
  });
}

for (const [type, wrapper] of [['type="button"', 'form'], ['', 'main']]) {
  test(`preserves safe custom button (${type || 'omitted type'}) in ${wrapper}`, async () => {
    const { document, button, events } = fixture(type, wrapper);
    assert.equal(collectFieldDescriptors(document).length, 1);
    const result = await fill(document);
    assert.equal(result.applied.length, 1);
    assert.equal(button.textContent, 'India');
    assert.deepEqual(events, { submit: 0, reset: 0 });
  });
}
