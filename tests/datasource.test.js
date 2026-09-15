import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  DATASOURCE_SCHEMA_VERSION,
  createDatasourceState,
  confirmBundledPublicLinks,
  mergeDatasource,
  parseDatasourceBackup,
  serializeDatasourceBackup,
  seedDatasource,
  shouldSeedDatasource,
} from '../src/datasource.js';
import { planDeterministicFill } from '../src/form-engine.js';

const root = new URL('../', import.meta.url);

test('migrates legacy datasource state to a profile with confirmed employer defaults', () => {
  const migrated = createDatasourceState({
    answerRecords: [{ key: 'email', question: 'Email', answer: 'nithin@example.com' }],
    datasourceMeta: { schemaVersion: 1 },
  });
  assert.equal(DATASOURCE_SCHEMA_VERSION, 3);
  assert.equal(migrated.schemaVersion, 3);
  assert.deepEqual(migrated.profile.employment.map((entry) => entry.company), ['DeepSight AI Labs']);
  assert.equal(migrated.profile.defaults.relatedToHiringCompany, 'No');
  assert.equal(migrated.profile.defaults.knownAtHiringCompany, 'No');
  assert.equal(migrated.profile.defaults.phoneDeviceType, 'Mobile');
});

test('preserves an editable phone device preference through backup normalization', () => {
  const state = createDatasourceState({
    answerRecords: [{ key: 'email', question: 'Email', answer: 'nithin@example.com' }],
    coverMessages: [],
    profile: { defaults: { phoneDeviceType: 'Landline' } },
  });
  assert.equal(state.profile.defaults.phoneDeviceType, 'Landline');
  assert.equal(parseDatasourceBackup(serializeDatasourceBackup(state)).profile.defaults.phoneDeviceType, 'Landline');
});

async function readSeed() {
  return JSON.parse(await readFile(new URL('../data/seed-data.json', import.meta.url), 'utf8'));
}

test('seed datasource contains the workbook answers and a separate cover message', async () => {
  const seed = await readSeed();
  assert.equal(seed.schemaVersion, DATASOURCE_SCHEMA_VERSION);
  assert.equal(seed.answerRecords.length, 36);
  assert.equal(seed.coverMessages.length, 1);
  const twitter = seed.answerRecords.find((record) => record.key === 'twitter');
  assert.equal(twitter.answer, 'https://x.com/call_me_Nithin');
  assert.deepEqual(twitter.alternatives, ['https://twitter.com/call_me_Nithin']);
  assert.equal(seed.answerRecords.some((record) => !record.answer), false);
  assert.match(seed.coverMessages[0].body, /Hi Noeon team/);
});

test('seeds only an uninitialized empty datasource', () => {
  assert.equal(shouldSeedDatasource({ answerRecords: [], coverMessages: [], datasourceMeta: null }), true);
  assert.equal(shouldSeedDatasource({ answerRecords: [{ key: 'email', answer: 'a@b.com' }], coverMessages: [], datasourceMeta: null }), false);
  assert.equal(shouldSeedDatasource({ answerRecords: [], coverMessages: [{ id: 'cover' }], datasourceMeta: null }), false);
  assert.equal(shouldSeedDatasource({ answerRecords: [], coverMessages: [], datasourceMeta: { initializedAt: '2026-01-01T00:00:00.000Z' } }), false);
});

test('confirms only untouched bundled public links', async () => {
  const seed = await readSeed();
  const seeded = seedDatasource(seed, '2026-09-03T00:00:00.000Z');
  assert.equal(seeded.answerRecords.find((record) => record.key === 'github').confirmationState, 'confirmed');
  assert.equal(seeded.answerRecords.find((record) => record.key === 'linkedin').confirmationState, 'confirmed');
  const legacy = {
    ...seeded,
    answerRecords: seeded.answerRecords.map((record) => ['github', 'linkedin'].includes(record.key)
      ? { ...record, confirmationState: undefined, confirmedAt: undefined, provenance: undefined }
      : record),
    datasourceMeta: { schemaVersion: 3, seedId: 'resume.xlsx' },
  };
  const migrated = confirmBundledPublicLinks(legacy, seed, '2026-09-04T00:00:00.000Z');
  assert.equal(migrated.answerRecords.find((record) => record.key === 'github').confirmationState, 'confirmed');
  assert.equal(migrated.answerRecords.find((record) => record.key === 'linkedin').confirmationState, 'confirmed');
  assert.equal(migrated.answerRecords.find((record) => record.key === 'about_me').confirmationState, undefined);
  assert.equal(migrated.datasourceMeta.bundledPublicLinksMigrationAt, '2026-09-04T00:00:00.000Z');
  assert.equal(migrated.datasourceMeta.bundledPublicLinksConfirmedAt, '2026-09-04T00:00:00.000Z');
  for (const changes of [
    { answer: 'https://github.com/edited' },
    { confirmationState: 'pending' },
    { alternatives: ['https://github.com/old'] },
    { history: [{ answer: 'old' }] },
    { entityId: 'employment-1' },
    { suppressedFor: ['github url|url'] },
    { provenance: 'user' },
  ]) {
    const record = { ...legacy.answerRecords.find((item) => item.key === 'github'), ...changes };
    const result = confirmBundledPublicLinks({ ...legacy, answerRecords: [record] }, seed, '2026-09-04T00:00:00.000Z');
    assert.equal(result.answerRecords[0].confirmationState, changes.confirmationState || undefined);
    assert.equal(result.datasourceMeta.bundledPublicLinksMigrationAt, '2026-09-04T00:00:00.000Z');
    assert.equal(result.datasourceMeta.bundledPublicLinksConfirmedAt, undefined);
  }
});

test('merges datasource records without losing newer values or alternatives', () => {
  const current = createDatasourceState({
    answerRecords: [{
      key: 'twitter',
      question: 'Twitter',
      answer: 'https://x.com/current',
      alternatives: ['https://twitter.com/current'],
      updatedAt: '2026-09-03T12:00:00.000Z',
    }],
    coverMessages: [],
  });
  const imported = createDatasourceState({
    answerRecords: [{
      key: 'twitter',
      question: 'Twitter profile',
      answer: 'https://x.com/older',
      alternatives: ['https://twitter.com/older'],
      updatedAt: '2026-09-03T11:00:00.000Z',
    }, {
      key: 'github',
      question: 'Github',
      answer: 'https://github.com/humandotlearning',
      updatedAt: '2026-09-03T11:00:00.000Z',
    }],
    coverMessages: [],
  });
  const merged = mergeDatasource(current, imported, '2026-09-03T13:00:00.000Z');
  const twitter = merged.answerRecords.find((record) => record.key === 'twitter');
  assert.equal(twitter.answer, 'https://x.com/current');
  assert.deepEqual(twitter.alternatives.sort(), ['https://twitter.com/current', 'https://twitter.com/older', 'https://x.com/older'].sort());
  assert.equal(merged.answerRecords.some((record) => record.key === 'github'), true);
});

test('merges cover messages by date while preserving unique aliases from both sources', () => {
  const current = { id: 'cover', label: 'Current', body: 'Current body', aliases: ['Résumé', 'Current'], updatedAt: '2026-09-03T12:00:00.000Z' };
  for (const updatedAt of ['2026-09-02T12:00:00.000Z', current.updatedAt, '2026-09-04T12:00:00.000Z']) {
    const incoming = { ...current, label: 'Imported', body: 'Imported body', aliases: ['resume', 'Imported'], updatedAt };
    const { coverMessages } = mergeDatasource({ coverMessages: [current] }, { coverMessages: [incoming] });
    assert.equal(coverMessages.length, 1);
    assert.equal(coverMessages[0].body, updatedAt > current.updatedAt ? incoming.body : current.body);
    assert.deepEqual(coverMessages[0].aliases, ['Résumé', 'Current', 'Imported']);
    assert.deepEqual(mergeDatasource({}, { coverMessages: [incoming] }).coverMessages, [incoming]);
  }
});

test('exports a backup without the API key and imports only valid backup data', () => {
  const state = createDatasourceState({
    answerRecords: [{ key: 'email', question: 'Email', answer: 'person@example.com' }],
    coverMessages: [{ id: 'cover-default', label: 'Cover message', body: 'Hello', updatedAt: '2026-09-03T12:00:00.000Z' }],
  });
  const backup = serializeDatasourceBackup(state);
  assert.equal('openaiApiKey' in backup, false);
  assert.deepEqual(parseDatasourceBackup(JSON.parse(JSON.stringify(backup))), backup);
  assert.throws(() => parseDatasourceBackup({ format: 'job-application-autofill-datasource', schemaVersion: DATASOURCE_SCHEMA_VERSION, answerRecords: 'bad', coverMessages: [] }), /answerRecords/);
});

test('suggests the cover message only for explicit cover-message fields', () => {
  const fields = [
    { id: 'cover', label: 'Cover letter', type: 'textarea', currentValue: '', options: [], constraints: {} },
    { id: 'additional', label: 'Additional information', type: 'textarea', currentValue: '', options: [], constraints: {} },
  ];
  const result = planDeterministicFill(fields, [], [{
    id: 'cover-default',
    label: 'Default cover message',
    body: 'Hello hiring team',
    aliases: ['cover letter', 'cover message'],
    updatedAt: '2026-09-03T12:00:00.000Z',
  }]);
  assert.equal(result.find((decision) => decision.fieldId === 'cover').action, 'fill');
  assert.equal(result.find((decision) => decision.fieldId === 'cover').value, 'Hello hiring team');
  assert.equal(result.find((decision) => decision.fieldId === 'cover').sensitivity, 'review');
  assert.equal(result.find((decision) => decision.fieldId === 'additional').action, 'ask_user');
});
