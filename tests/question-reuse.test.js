import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { collectFieldDescriptors, applyDecisions, collectAnswerRecords } from '../src/form-engine.js';

test('opaque question identities cannot be promoted by Save as reusable semantics', () => {
  const doc = new JSDOM('<form><textarea name="cards[synthetic][field9]">Manual synthetic value</textarea></form>').window.document;
  const [record] = collectAnswerRecords(doc);
  assert.equal(record.completed, false);
});

test('unknown or skipped decision actions never mutate a field', async () => {
  const doc = new JSDOM('<label>Current CTC<textarea id="ctc"></textarea></label>').window.document;
  await applyDecisions(doc, [{ fieldId: 'ctc', action: 'skip', value: 'Never apply' }]);
  assert.equal(doc.querySelector('textarea').value, '');
});
import { chooseRecord, canonicalConcept } from '../src/core.js';

test('general compensation synonyms preserve current versus expected and legacy keys', () => {
  const record = { key: 'current_salary', question: 'Current salary', answer: 'Synthetic compensation explanation', confirmationState: 'confirmed' };
  assert.equal(canonicalConcept('Please enter your Current CTC *'), 'current_compensation');
  assert.equal(chooseRecord({ label: 'Current CTC' }, [record])?.record.key, 'current_salary');
  assert.equal(chooseRecord({ label: 'Expected CTC' }, [record]), null);
});

test('meaning facets block fuzzy cross-matches and uncertain numeric compensation', () => {
  const pick = (label, question, answer = '60') => chooseRecord({ label, type: 'number' }, [{ key: 'legacy', question, answer }]);
  for (const [label, question] of [['Current annual salary USD', 'Current monthly salary INR'], ['Current fixed CTC', 'Current total CTC'], ['Expected salary', 'Current salary'], ['Available start date', 'Notice period'], ['Willing to relocate', 'Current location']]) assert.equal(pick(label, question), null, label);
  assert.equal(pick('Current CTC in LPA', 'Current salary'), null);
  assert.equal(chooseRecord({ label: 'Present company' }, [{ key: 'legacy_company', question: 'Current employer', answer: 'Example' }])?.record.answer, 'Example');
  assert.equal(canonicalConcept('Please enter your mobile number'), 'phone');
});

test('custom choices use the bounded question resolver and explain the label', () => {
  const doc = new JSDOM('<form><div><h3>Current employer</h3><button type="button" role="combobox" aria-label="Select one">Select one</button></div></form>').window.document;
  const [field] = collectFieldDescriptors(doc);
  assert.equal(field.label, 'Current employer');
  assert.equal(field.labelConfidence, 'high');
});

test('shared control ARIA identifies the radio question, not an option', () => {
  const doc = new JSDOM('<form><div><span id="q">Are you authorized to work?</span><input type="radio" name="opaque" aria-labelledby="q" value="Yes"><input type="radio" name="opaque" aria-labelledby="q" value="No"></div></form>').window.document;
  const [field] = collectFieldDescriptors(doc);
  assert.equal(field.label, 'Are you authorized to work?');
  assert.deepEqual(field.options, ['Yes', 'No']);
});

test('deep Lever radio wrapper recovers question without crossing competing controls', () => {
  const doc = new JSDOM(`<form><div><div class="application-label"><div class="text">ML experience</div></div><div class="application-field"><ul><li><label><input type="radio" name="cards[synthetic][field3]">Yes</label></li><li><label><input type="radio" name="cards[synthetic][field3]">No</label></li></ul></div></div><div><h3 hidden>Hidden</h3><div class="help">Help</div><h3>Ambiguous A</h3><h3>Ambiguous B</h3><input name="opaque"></div><div><h3>Neighbor</h3><input name="one"><input name="two"></div></form>`).window.document;
  const fields = collectFieldDescriptors(doc);
  assert.equal(fields[0].label, 'ML experience');
  assert.equal(fields[1].labelConfidence, 'low');
  assert.equal(fields[2].labelConfidence, 'low');
});

test('bounded Lever questions keep group options separate and explain label origin', () => {
  const doc = new JSDOM(`<form id="application"><div><div class="application-label"><div class="text">Notice Period</div></div><div><textarea name="cards[synthetic][field1]"></textarea></div></div><div><div class="application-label"><div class="text">Pharma Domain experience?</div></div><div><label><input type="radio" name="pharma">Yes</label><label><input type="radio" name="pharma">No</label></div></div><div><h3>Production ML experience?</h3><label><input type="radio" name="ml">Yes</label><label><input type="radio" name="ml">No</label></div></form>`).window.document;
  const fields = collectFieldDescriptors(doc);
  assert.deepEqual(fields.map(f => f.label), ['Notice Period', 'Pharma Domain experience?', 'Production ML experience?']);
  assert.deepEqual(fields[1].options, ['Yes', 'No']);
  assert.equal(fields[0].labelSource, 'nearby-question');
  assert.equal(fields[0].labelConfidence, 'high');
});
