import { normalizeAnswerRecord, normalizeText, slugify, upsertAnswerRecords } from './core.js';

export const DATASOURCE_SCHEMA_VERSION = 3;
export const DATASOURCE_FORMAT = 'job-application-autofill-datasource';

export const DEFAULT_PROFILE = Object.freeze({
  employment: [{ id: 'deepsight-ai-labs', company: 'DeepSight AI Labs' }],
  defaults: {
    relatedToHiringCompany: 'No',
    knownAtHiringCompany: 'No',
    phoneDeviceType: 'Mobile',
  },
});

function uniqueStrings(values = []) {
  const seen = new Set();
  return values
    .map((value) => String(value ?? '').trim())
    .filter((value) => value && !seen.has(normalizeText(value)) && seen.add(normalizeText(value)));
}

function timestamp(value, fallback = new Date().toISOString()) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : fallback;
}

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

export function createDatasourceState({ answerRecords = [], coverMessages = [], learningInbox = [], datasourceMeta = null, profile = {} } = {}) {
  return {
    schemaVersion: DATASOURCE_SCHEMA_VERSION,
    answerRecords: answerRecords
      .map(normalizeAnswerRecord)
      .filter((record) => record.key && record.answer),
    coverMessages: coverMessages
      .map(normalizeCoverMessage)
      .filter((message) => message.id && message.body),
    learningInbox: Array.isArray(learningInbox) ? learningInbox.filter(item => item && typeof item === 'object' && item.id && item.candidate) : [],
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

function mergeRecords(current = [], imported = []) {
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
    if (!previous || isNewer(candidate, previous)) {
      merged.set(candidate.id, {
        ...candidate,
        aliases: uniqueStrings([...(previous?.aliases || []), ...(candidate.aliases || [])]),
      });
    } else {
      merged.set(candidate.id, {
        ...previous,
        aliases: uniqueStrings([...(previous.aliases || []), ...(candidate.aliases || [])]),
      });
    }
  }
  return [...merged.values()];
}

export function mergeDatasource(current = {}, imported = {}, updatedAt = new Date().toISOString()) {
  const existing = createDatasourceState(current);
  const incoming = createDatasourceState(imported);
  return {
    schemaVersion: DATASOURCE_SCHEMA_VERSION,
    answerRecords: mergeRecords(existing.answerRecords, incoming.answerRecords),
    coverMessages: mergeCoverMessages(existing.coverMessages, incoming.coverMessages),
    learningInbox: imported?.learningInbox ? incoming.learningInbox : existing.learningInbox,
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
    profile: normalized.profile,
    datasourceMeta: normalized.datasourceMeta,
  };
}

export function parseDatasourceBackup(value) {
  if (!value || typeof value !== 'object') throw new Error('Backup must be a JSON object');
  if (value.format !== DATASOURCE_FORMAT) throw new Error('Backup format is not supported');
  if (![1, 2, DATASOURCE_SCHEMA_VERSION].includes(value.schemaVersion)) throw new Error('Backup schema version is not supported');
  if (!Array.isArray(value.answerRecords)) throw new Error('Backup answerRecords must be an array');
  if (!Array.isArray(value.coverMessages)) throw new Error('Backup coverMessages must be an array');
  return serializeDatasourceBackup(value);
}

export function seedDatasource(seed, initializedAt = new Date().toISOString()) {
  const normalized = createDatasourceState(seed);
  return {
    ...normalized,
    datasourceMeta: {
      schemaVersion: DATASOURCE_SCHEMA_VERSION,
      seedId: String(seed.seedId || 'bundled-seed'),
      seededAt: timestamp(initializedAt),
      initializedAt: timestamp(initializedAt),
    },
  };
}

export function mergeAnswerRecords(current = [], imported = []) {
  return mergeRecords(current, imported);
}
