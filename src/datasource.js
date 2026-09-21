import { normalizeAnswerRecord, normalizeText, slugify, timestamp, uniqueStrings } from './core.js';

export const DATASOURCE_SCHEMA_VERSION = 4;
export const DATASOURCE_FORMAT = 'job-application-autofill-datasource';
export const BUNDLED_SEED_ID = 'resume.xlsx';

export const DEFAULT_PROFILE = Object.freeze({
  employment: [{ id: 'deepsight-ai-labs', company: 'DeepSight AI Labs' }],
  defaults: {
    relatedToHiringCompany: 'No',
    knownAtHiringCompany: 'No',
    phoneDeviceType: 'Mobile',
  },
});

export function normalizeCoverMessage(message = {}) {
  const label = String(message.label || message.question || message.id || 'Cover message').trim();
  const body = String(message.body ?? message.answer ?? '').trim();
  const id = slugify(message.id || label) || 'cover_message';
  const aliases = uniqueStrings(Array.isArray(message.aliases) ? message.aliases : []);
  if (!aliases.length) aliases.push(label);
  return {
    id,
    label,
    body,
    aliases,
    updatedAt: timestamp(message.updatedAt),
  };
}

function normalizeProfile(profile = {}) {
  const phoneDeviceType = String(profile.defaults?.phoneDeviceType || '').trim().toLowerCase();
  const employment = Array.isArray(profile.employment) && profile.employment.length
    ? profile.employment
      .map((entry) => ({
        ...entry,
        id: slugify(entry?.id || entry?.company),
        company: String(entry?.company || '').trim(),
        roles: Array.isArray(entry?.roles) ? entry.roles.filter((role) => role && typeof role === 'object') : [],
      }))
      .filter((entry) => entry.id && entry.company)
    : DEFAULT_PROFILE.employment.map((entry) => ({ ...entry, roles: [] }));
  return {
    employment,
    defaults: {
      relatedToHiringCompany: profile.defaults?.relatedToHiringCompany === 'Yes' ? 'Yes' : DEFAULT_PROFILE.defaults.relatedToHiringCompany,
      knownAtHiringCompany: profile.defaults?.knownAtHiringCompany === 'Yes' ? 'Yes' : DEFAULT_PROFILE.defaults.knownAtHiringCompany,
      phoneDeviceType: phoneDeviceType === 'landline' ? 'Landline'
        : phoneDeviceType === 'mobile' ? 'Mobile'
          : DEFAULT_PROFILE.defaults.phoneDeviceType,
    },
  };
}

export function createDatasourceState({ answerRecords = [], coverMessages = [], learningInbox = [], learningUndo = null, datasourceMeta = null, profile = {} } = {}) {
  return {
    schemaVersion: DATASOURCE_SCHEMA_VERSION,
    answerRecords: answerRecords
      .map(normalizeAnswerRecord)
      .filter((record) => record.key && record.answer),
    coverMessages: coverMessages
      .map(normalizeCoverMessage)
      .filter((message) => message.id && message.body),
    learningInbox: Array.isArray(learningInbox) ? learningInbox.filter(item => item && typeof item === 'object' && item.id && item.candidate) : [],
    learningUndo: learningUndo && typeof learningUndo === 'object' ? learningUndo : null,
    profile: normalizeProfile(profile),
    datasourceMeta: datasourceMeta ? { ...datasourceMeta, schemaVersion: DATASOURCE_SCHEMA_VERSION } : null,
  };
}

export function shouldSeedDatasource(state = {}) {
  return !state.datasourceMeta
    && (!Array.isArray(state.answerRecords) || state.answerRecords.length === 0)
    && (!Array.isArray(state.coverMessages) || state.coverMessages.length === 0);
}

function isNewer(left, right) {
  return Date.parse(left.updatedAt) > Date.parse(right.updatedAt);
}

export function mergeAnswerRecords(current = [], imported = []) {
  const merged = new Map();
  for (const candidate of [...current, ...imported].map(normalizeAnswerRecord).filter((record) => record.key && record.answer)) {
    const previous = merged.get(candidate.key);
    if (!previous) {
      merged.set(candidate.key, candidate);
      continue;
    }
    const winner = isNewer(candidate, previous) ? candidate : previous;
    const alternatives = uniqueStrings([
      ...(previous.alternatives || []),
      ...(candidate.alternatives || []),
      previous.answer,
      candidate.answer,
    ]).filter((value) => normalizeText(value) !== normalizeText(winner.answer));
    const history = uniqueStrings([
      ...(previous.history || []).map((item) => JSON.stringify(item)),
      ...(candidate.history || []).map((item) => JSON.stringify(item)),
    ]).map((item) => JSON.parse(item));
    merged.set(candidate.key, {
      ...winner,
      aliases: uniqueStrings([
        ...(previous.aliases || []),
        ...(candidate.aliases || []),
        previous.question,
        candidate.question,
      ]),
      ...(alternatives.length ? { alternatives } : {}),
      ...(history.length ? { history } : {}),
    });
  }
  return [...merged.values()];
}

function mergeCoverMessages(current = [], imported = []) {
  const merged = new Map(current.map((message) => [message.id, normalizeCoverMessage(message)]));
  for (const candidate of imported.map(normalizeCoverMessage).filter((message) => message.id && message.body)) {
    const previous = merged.get(candidate.id);
    merged.set(candidate.id, {
      ...(!previous || isNewer(candidate, previous) ? candidate : previous),
      aliases: uniqueStrings([...(previous?.aliases || []), ...(candidate.aliases || [])]),
    });
  }
  return [...merged.values()];
}

export function mergeDatasource(current = {}, imported = {}, updatedAt = new Date().toISOString()) {
  const existing = createDatasourceState(current);
  const incoming = createDatasourceState(imported);
  return {
    schemaVersion: DATASOURCE_SCHEMA_VERSION,
    answerRecords: mergeAnswerRecords(existing.answerRecords, incoming.answerRecords),
    coverMessages: mergeCoverMessages(existing.coverMessages, incoming.coverMessages),
    learningInbox: imported?.learningInbox ? incoming.learningInbox : existing.learningInbox,
    learningUndo: existing.learningUndo,
    // A v1 backup has no profile, so it must not reset defaults the applicant
    // has already confirmed in their installed datasource.
    profile: imported?.profile ? incoming.profile : existing.profile,
    datasourceMeta: {
      ...(existing.datasourceMeta || incoming.datasourceMeta || {}),
      schemaVersion: DATASOURCE_SCHEMA_VERSION,
      updatedAt: timestamp(updatedAt),
    },
  };
}

export function serializeDatasourceBackup(state = {}) {
  const normalized = createDatasourceState(state);
  return {
    format: DATASOURCE_FORMAT,
    schemaVersion: DATASOURCE_SCHEMA_VERSION,
    answerRecords: normalized.answerRecords,
    coverMessages: normalized.coverMessages,
    learningInbox: normalized.learningInbox,
    learningUndo: normalized.learningUndo,
    profile: normalized.profile,
    datasourceMeta: normalized.datasourceMeta,
  };
}

export function parseDatasourceBackup(value) {
  if (!value || typeof value !== 'object') throw new Error('Backup must be a JSON object');
  if (value.format !== DATASOURCE_FORMAT) throw new Error('Backup format is not supported');
  if (![1, 2, 3, DATASOURCE_SCHEMA_VERSION].includes(value.schemaVersion)) throw new Error('Backup schema version is not supported');
  if (!Array.isArray(value.answerRecords)) throw new Error('Backup answerRecords must be an array');
  if (!Array.isArray(value.coverMessages)) throw new Error('Backup coverMessages must be an array');
  return serializeDatasourceBackup(value);
}

export function seedDatasource(seed, initializedAt = new Date().toISOString()) {
  const normalized = createDatasourceState(seed);
  return confirmBundledPublicLinks({
    ...normalized,
    datasourceMeta: {
      schemaVersion: DATASOURCE_SCHEMA_VERSION,
      seedId: String(seed.seedId || 'bundled-seed'),
      seededAt: timestamp(initializedAt),
      initializedAt: timestamp(initializedAt),
    },
  }, seed, initializedAt);
}

export function confirmBundledPublicLinks(state = {}, seed = null, confirmedAt = new Date().toISOString()) {
  if (state.datasourceMeta?.seedId !== BUNDLED_SEED_ID || state.datasourceMeta?.bundledPublicLinksMigrationAt || !seed) return state;
  const expected = new Map((seed.answerRecords || [])
    .filter((record) => ['github', 'linkedin'].includes(record.key))
    .map((record) => [record.key, record.answer]));
  let changed = false;
  const answerRecords = (state.answerRecords || []).map((record) => {
    const expectedAnswer = expected.get(record.key);
    const untouched = expectedAnswer
      && record.answer === expectedAnswer
      && record.sensitivity === 'safe'
      && !record.confirmationState
      && !record.pendingAnswer
      && !record.alternatives?.length
      && !record.history?.length
      && !record.entityId
      && !record.entityType
      && !record.employmentId
      && !record.suppressedFor?.length
      && !record.provenance;
    if (!untouched) return record;
    changed = true;
    return { ...record, confirmationState: 'confirmed', confirmedAt, provenance: 'seed' };
  });
  return {
    ...state,
    answerRecords,
    datasourceMeta: { ...state.datasourceMeta, bundledPublicLinksMigrationAt: confirmedAt, ...(changed ? { bundledPublicLinksConfirmedAt: confirmedAt } : {}) },
  };
}
