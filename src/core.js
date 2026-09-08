import { conceptForNormalized } from './concepts.js';

const AUTOCOMPLETE_KEYS = {
  email: ['email'],
  tel: ['phone', 'phone_number', 'mobile'],
  name: ['full_name', 'name'],
  'given name': ['first_name', 'given_name'],
  'family name': ['last_name', 'family_name', 'surname'],
  country: ['country'],
  'country name': ['country'],
  'address level1': ['state', 'region'],
  'address level2': ['city'],
  'postal code': ['postal_code', 'zip_code', 'pincode'],
  'street address': ['address', 'street_address'],
  organization: ['current_employer', 'employer', 'company'],
  url: ['website', 'linkedin', 'portfolio', 'github'],
};

const GENERIC_NAME_LABELS = new Set(['name', 'your name', 'applicant name', 'candidate name']);

export function canonicalConcept(value = '') {
  return conceptForNormalized(normalizeText(value));
}

const SENSITIVITIES = new Set(['safe', 'review', 'legal']);

function timestamp(value, fallback = new Date().toISOString()) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : fallback;
}

export function normalizeText(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\*/g, ' ')
    .replace(/\((?:required|optional)\)/gi, ' ')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function slugify(value = '') {
  return normalizeText(value).replace(/\s+/g, '_');
}

export function inferSensitivity(question, key = '') {
  const text = normalizeText(`${key} ${question}`);
  if (/\b(consent|agree|agreement|certif(?:y|ication)|attest|attestation|privacy|terms|declaration|conflict of interest|criminal|gender|race|ethnicity|disability|veteran)\b/.test(text)) {
    return 'legal';
  }
  if (/\b(ctc|salary|compensation|notice period|sponsorship|sponsor|visa|citizenship|work authorization|reference|reason for leaving|relocat)\b/.test(text)) {
    return 'review';
  }
  if (/\b(ssn|social security|passport|national identity|date of birth|birthday)\b/.test(text)) return 'review';
  return 'safe';
}

function uniqueStrings(values = []) {
  const seen = new Set();
  return values
    .map((value) => String(value ?? '').trim())
    .filter((value) => value && !seen.has(normalizeText(value)) && seen.add(normalizeText(value)));
}

export function normalizeAnswerRecord(record = {}) {
  const question = String(record.question || record.label || record.key || '').trim();
  let key = slugify(record.key || question);
  // Employment sections receive unstable DOM ids on every ATS.  A saved
  // employment identity is the durable scope used to carry an answer across
  // those sections (for example, Lever -> Workday).
  const scope = slugify(record.employmentId || record.entityId || '');
  if (scope && !key.endsWith(`_${scope}`)) key = `${key}_${scope}`;
  const answer = String(record.answer ?? '').trim();
  const aliases = uniqueStrings(Array.isArray(record.aliases) ? record.aliases : []);
  const alternatives = uniqueStrings(Array.isArray(record.alternatives) ? record.alternatives : [])
    .filter((value) => normalizeText(value) !== normalizeText(answer));
  if (!aliases.length && question) aliases.push(question);
  const sensitivity = SENSITIVITIES.has(record.sensitivity) ? record.sensitivity : inferSensitivity(question, key);
  const updatedAt = typeof record.updatedAt === 'string' && !Number.isNaN(Date.parse(record.updatedAt))
    ? record.updatedAt
    : new Date().toISOString();
  const normalized = {
    key,
    question: question || key.replace(/_/g, ' '),
    answer,
    aliases,
    type: String(record.type || 'text'),
    sensitivity,
    updatedAt,
  };
  for (const key of ['id', 'concept', 'entityId', 'entityType', 'employmentId', 'context', 'provenance', 'confirmedAt', 'confirmationState', 'pendingAnswer']) {
    if (record[key] != null && String(record[key]).trim()) normalized[key] = String(record[key]).trim();
  }
  if (Array.isArray(record.evidenceKeys)) normalized.evidenceKeys = uniqueStrings(record.evidenceKeys);
  const suppressedFor = uniqueStrings(Array.isArray(record.suppressedFor) ? record.suppressedFor : [])
    .map((value) => {
      const [label, type] = String(value).split('|');
      const normalizedLabel = normalizeText(label);
      const normalizedType = normalizeText(type);
      return normalizedLabel && normalizedType ? `${normalizedLabel}|${normalizedType}` : '';
    })
    .filter(Boolean);
  if (suppressedFor.length) normalized.suppressedFor = suppressedFor;
  if (record.semantic && typeof record.semantic === 'object' && !Array.isArray(record.semantic)) normalized.semantic = { ...record.semantic };
  if (Array.isArray(record.history) && record.history.length) {
    normalized.history = record.history.map((item) => ({
      answer: String(item?.answer ?? '').trim(),
      updatedAt: timestamp(item?.updatedAt, updatedAt),
      provenance: String(item?.provenance || 'unknown'),
    })).filter((item) => item.answer);
  }
  for (const key of ['userEdited', 'completed']) if (typeof record[key] === 'boolean') normalized[key] = record[key];
  for (const key of ['formOrder', 'pageNumber']) if (Number.isInteger(record[key])) normalized[key] = record[key];
  if (alternatives.length) normalized.alternatives = alternatives;
  return normalized;
}

export function suggestionTargetKey(field = {}) {
  const label = normalizeText(field.label || field.question || field.id || '');
  const type = normalizeText(field.type || field.fieldType || 'text') || 'text';
  return label ? `${label}|${type}` : '';
}

function tokens(value) {
  return new Set(normalizeText(value).split(' ').filter((token) => token.length > 1));
}

function similarity(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / new Set([...a, ...b]).size;
}

function compactText(value) {
  return normalizeText(value).replace(/\s+/g, '');
}

function candidateLabels(record) {
  return [record.key?.replace(/_/g, ' '), record.question, ...(record.aliases || [])]
    .map(normalizeText)
    .filter(Boolean);
}

export function recordScopeCompatible(field, record) {
  if (record.confirmationState === 'pending') return false;
  if (record.alternatives?.length && record.confirmationState !== 'confirmed') return false;
  if (record.employmentId && record.employmentId !== field.employmentId) return false;
  const sameEmployment = Boolean(field.employmentId && record.employmentId && field.employmentId === record.employmentId);
  if (field.entityId && record.entityId && field.entityId !== record.entityId && !sameEmployment) return false;
  if (record.entityId && !field.entityId) return false;
  if (field.entityType && record.entityType && field.entityType !== record.entityType) return false;
  const otherPerson = /reference|referee|emergency|supervisor|manager/;
  if (otherPerson.test(normalizeText(field.section)) || otherPerson.test(normalizeText(record.context))) {
    if (normalizeText(field.section) !== normalizeText(record.context)) return false;
  }
  if (field.entityType && !record.entityId && /company|employer|school|university|degree|job title/.test(normalizeText(record.question || record.key))) return false;
  return true;
}

export function meaningCompatible(field, record, { numericReview = true } = {}) {
  const left = normalizeText(field.label || field.question);
  const right = normalizeText(record.question || record.key);
  const fieldConcept = canonicalConcept(field.label || field.question || field.name || field.id || '');
  const recordConcept = canonicalConcept(record.concept || record.key || record.question);
  const protectedConcepts = ['first_name', 'last_name', 'full_name', 'preferred_name', 'github_url', 'linkedin_url', 'portfolio_url', 'date_of_birth'];
  if (protectedConcepts.includes(fieldConcept) && recordConcept !== fieldConcept) return false;
  const locationGranularity = text => /\bcity\b/.test(text) ? 'city' : /\b(location|address)\b/.test(text) ? 'location' : '';
  const leftLocation = locationGranularity(left);
  const rightLocation = locationGranularity(right);
  if (leftLocation && rightLocation && leftLocation !== rightLocation) return false;
  const compensation = text => /\b(salary|ctc|compensation|pay)\b/.test(text);
  if (compensation(left) || compensation(right)) {
    if (!compensation(left) || !compensation(right)) return false;
    // Period and monetary scale are independent: LPA is annual *lakhs*.
    const scale = text => /\b(lpa|lakhs?|lacs?)\b/.test(text) ? 'lakh' : /\bmillions?\b/.test(text) ? 'million' : /\bthousands?\b/.test(text) ? 'thousand' : 'unit';
    const destinationUnspecified = !/\b(lpa|lakhs?|lacs?|millions?|thousands?|usd|inr|eur|gbp|annual|annually|yearly|monthly|hourly)\b/.test(left);
    const reviewUnspecified = !numericReview && destinationUnspecified;
    if (!reviewUnspecified && scale(left) !== scale(right)) return false;
    const answerScale = scale(normalizeText(record.answer));
    if (!reviewUnspecified && answerScale !== 'unit' && answerScale !== scale(left)) return false;
    const facet = (text, pattern) => text.match(pattern)?.[0] || '';
    for (const pattern of [/\b(current|expected|desired|previous)\b/, /\b(fixed|base|variable|total)\b/, /\b(usd|inr|eur|gbp)\b/, /\b(annual|annually|yearly|monthly|hourly|lpa)\b/]) {
      const canonical = value => ({ desired: 'expected', base: 'fixed', annually: 'annual', yearly: 'annual', lpa: 'annual' }[value] || value);
      const a = canonical(facet(left, pattern));
      const b = canonical(facet(right, pattern));
      if (a !== b && (a && b || /fixed|variable/.test(a + b))) return false;
      const amount = String(record.answer).trim().replace(/\b(?:USD|INR|EUR|GBP|LPA|lakhs?|lacs?|millions?|thousands?|annual(?:ly)?|yearly|monthly|hourly|per|annum|year|month|hour)\b/gi, '').replace(/[\p{Sc},\s]/gu, '');
      if (numericReview && /^[+-]?\d+(?:\.\d+)?$/.test(amount) && a !== b) return false;
    }
  }
  const family = text => /notice/.test(text) ? 'notice' : /start date|date available/.test(text) ? 'date' : /relocat|willing|work in/.test(text) ? 'relocation' : /current location|current city/.test(text) ? 'location' : '';
  if (family(left) && family(right) && family(left) !== family(right)) return false;
  return true;
}

export function chooseRecord(field = {}, records = []) {
  if (!Array.isArray(records) || records.length === 0) return null;
  records = records.filter((record) => recordScopeCompatible(field, record) && meaningCompatible(field, record));
  const fieldTexts = [field.label, field.name, field.id, field.placeholder]
    .map(normalizeText)
    .filter(Boolean);
  const autocomplete = normalizeText(String(field.autocomplete || '').split(' ').at(-1));
  const autocompleteToken = normalizeText(String(field.autocomplete || '').replace(/\s+/g, ' '));
  const fieldLabel = fieldTexts.join(' ');
  const preferredKeys = AUTOCOMPLETE_KEYS[autocompleteToken] || AUTOCOMPLETE_KEYS[autocomplete] || [];
  const fieldConcept = canonicalConcept(field.label || field.name || field.id || '');
  const unambiguous = (candidates) => new Set(candidates.map((record) => String(record.answer).trim())).size === 1 ? candidates[0] : null;
  if (fieldConcept === 'generic_name') {
    const fullName = unambiguous(records.filter((record) => canonicalConcept(record.concept || record.key || record.question) === 'full_name' && String(record.answer ?? '').trim()));
    return fullName ? { record: fullName, confidence: 'high', score: 1, reason: 'generic-name:full_name' } : null;
  }
  if (fieldConcept) {
    const conceptCandidates = records.filter((record) => String(record.answer ?? '').trim()
      && [record.concept, record.key, record.question, ...(record.aliases || [])].filter(Boolean).some(label => canonicalConcept(label) === fieldConcept));
    if (conceptCandidates.length > 1 && !unambiguous(conceptCandidates)) return null;
    const conceptMatch = unambiguous(conceptCandidates);
    if (conceptMatch) return { record: conceptMatch, confidence: 'high', score: 1, reason: `concept:${fieldConcept}` };
  }
  if (preferredKeys.length || autocompleteToken === 'url') {
    let candidates = records.filter((record) => preferredKeys.includes(slugify(record.key)) && String(record.answer ?? '').trim());
    if (autocompleteToken === 'url') {
      const compatible = records.filter((record) => {
        const concept = canonicalConcept(record.key || record.question);
        return String(record.answer ?? '').trim()
          && (concept === fieldConcept || candidateLabels(record).some((candidate) => fieldLabel.includes(normalizeText(candidate))));
      });
      if (compatible.length) candidates = compatible;
      else candidates = [];
    }
    const exact = unambiguous(candidates);
    if (exact) return { record: exact, confidence: 'exact', score: 1, reason: `autocomplete:${autocomplete}` };
  }

  let best = null;
  const bestByRecord = new Map();
  for (const record of records) {
    if (!String(record.answer ?? '').trim()) continue;
    const recordConcept = canonicalConcept(record.concept || record.key || record.question);
    if (['first_name', 'last_name', 'full_name', 'preferred_name', 'github_url', 'linkedin_url', 'portfolio_url', 'date_of_birth'].includes(fieldConcept)
      && recordConcept !== fieldConcept) continue;
    if (fieldConcept && fieldConcept !== 'generic_name' && fieldConcept !== slugify(field.label || field.name || field.id || '')
      && recordConcept !== fieldConcept
      && ['github_url', 'linkedin_url', 'portfolio_url'].includes(fieldConcept)) continue;
    for (const fieldText of fieldTexts) {
      for (const candidate of candidateLabels(record)) {
        const compactFieldText = compactText(fieldText);
        const compactCandidate = compactText(candidate);
        const score = fieldText === candidate || compactFieldText === compactCandidate
          ? 1
          : similarity(fieldText, candidate);
        const candidateMatch = { record, score, reason: `label:${candidate}` };
        if (!bestByRecord.has(record.key) || score > bestByRecord.get(record.key).score) bestByRecord.set(record.key, candidateMatch);
        if (!best || score > best.score) best = candidateMatch;
      }
    }
  }

  if (!best || best.score < 0.5) return null;
  const ranked = [...bestByRecord.values()].sort((left, right) => right.score - left.score);
  if (ranked.length > 1 && ranked[1].score === best.score && ranked[1].record.key !== best.record.key) return null;
  return {
    ...best,
    confidence: best.score >= 0.9 ? 'high' : best.score >= 0.7 ? 'high' : 'medium',
  };
}

function numberConstraint(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function validateFillValue(field = {}, value) {
  if (value == null || String(value).trim() === '') return { ok: false, reason: 'value is empty' };
  const text = String(value).trim();
  const constraints = field.constraints || {};
  if (Array.isArray(field.options) && field.options.length) {
    const values = field.multiple ? text.split(/\s*[,;]\s*/) : [text];
    if (!values.every((value) => field.options.some((option) => normalizeText(option) === normalizeText(value)))) {
      return { ok: false, reason: 'value is not one of the available options' };
    }
  }
  if (constraints.minLength != null && text.length < Number(constraints.minLength)) return { ok: false, reason: 'value is shorter than the field minimum' };
  if (constraints.maxLength != null && text.length > Number(constraints.maxLength)) return { ok: false, reason: 'value is longer than the field maximum' };
  if (constraints.pattern) {
    try {
      if (!(new RegExp(constraints.pattern)).test(text)) return { ok: false, reason: 'value does not match the field pattern' };
    } catch {
      return { ok: false, reason: 'field pattern is invalid' };
    }
  }
  const type = normalizeText(field.type);
  if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return { ok: false, reason: 'value is not a valid email' };
  if (type === 'url') {
    try {
      if (!/^https?:/i.test(text)) throw new Error('protocol');
      new URL(text);
    } catch {
      return { ok: false, reason: 'value is not a valid URL' };
    }
  }
  if (type === 'number' || type === 'range') {
    const numeric = Number(text);
    if (!Number.isFinite(numeric)) return { ok: false, reason: 'value is not numeric' };
    if (constraints.min != null && numeric < numberConstraint(constraints.min, -Infinity)) return { ok: false, reason: 'value is below the minimum' };
    if (constraints.max != null && numeric > numberConstraint(constraints.max, Infinity)) return { ok: false, reason: 'value is above the maximum' };
  }
  if (type === 'checkbox' && !['yes', 'no', 'true', 'false', 'checked', 'unchecked'].includes(normalizeText(text))) {
    return { ok: false, reason: 'checkbox value must be yes or no' };
  }
  return { ok: true, reason: 'valid' };
}

export function shouldReviewDecision(decision = {}, field = {}) {
  return decision.sensitivity !== 'safe'
    || decision.confidence !== 'high'
    || normalizeText(field.type) === 'textarea'
    || String(decision.value ?? '').length > 240;
}

export function shouldAutofill(record = {}) {
  return String(record.answer ?? '').trim() !== '' && record.sensitivity === 'safe';
}

export function upsertAnswerRecords(existing = [], incoming = [], updatedAt = new Date().toISOString()) {
  const merged = new Map();
  for (const record of existing) {
    const normalized = normalizeAnswerRecord(record);
    if (normalized.key && normalized.answer) merged.set(normalized.key, normalized);
  }
  for (const record of incoming) {
    const next = normalizeAnswerRecord({ ...record, updatedAt });
    if (!next.key || !next.answer) continue;
    const previous = merged.get(next.key);
    if (!previous) {
      merged.set(next.key, next);
      continue;
    }
    const history = [
      ...(previous.history || []),
      ...(next.history || []),
      ...(normalizeText(previous.answer) !== normalizeText(next.answer)
        && (previous.provenance || next.provenance)
        ? [{ answer: previous.answer, updatedAt: previous.updatedAt, provenance: previous.provenance || 'unknown' }]
        : []),
    ];
    merged.set(next.key, {
      ...next,
      aliases: uniqueStrings([
        ...(previous.aliases || []),
        ...(next.aliases || []),
        previous.question,
        next.question,
      ]),
      ...(uniqueStrings([...(previous.alternatives || []), ...(next.alternatives || [])])
        .filter((value) => normalizeText(value) !== normalizeText(next.answer)).length
        ? { alternatives: uniqueStrings([...(previous.alternatives || []), ...(next.alternatives || [])])
          .filter((value) => normalizeText(value) !== normalizeText(next.answer)) }
        : {}),
      ...(history.length ? { history } : {}),
    });
  }
  return [...merged.values()];
}

export function mergeLearnedAnswers(existing = [], incoming = [], now = new Date().toISOString(), { confirm = false } = {}) {
  let result = existing.map(normalizeAnswerRecord);
  for (const raw of incoming) {
    if (raw.provenance !== 'user' || raw.completed === false || !validateFillValue({ type: raw.type }, raw.answer).ok) continue;
    const next = normalizeAnswerRecord({ ...raw, updatedAt: now });
    const previous = result.find((record) => record.key === next.key);
    const changed = previous && previous.answer !== next.answer;
    const sensitive = inferSensitivity(next.question, next.key) !== 'safe' || next.sensitivity !== 'safe';
    if (changed && confirm) {
      result = upsertAnswerRecords(result, [{
        ...next,
        id: next.id || next.key,
        concept: next.concept || canonicalConcept(next.question),
        confirmationState: 'confirmed',
        pendingAnswer: '',
        confirmedAt: now,
      }], now);
    } else if (changed) {
      result = result.map((record) => record.key === next.key ? {
        ...record,
        pendingAnswer: next.answer,
        confirmationState: 'pending',
        alternatives: uniqueStrings([...(record.alternatives || []), next.answer]),
      } : record);
    } else if (!previous) {
      result = upsertAnswerRecords(result, [{ ...next, id: next.id || next.key,
        concept: next.concept || canonicalConcept(next.question),
        confirmationState: confirm || !sensitive ? 'confirmed' : 'pending',
        ...(confirm || !sensitive ? { confirmedAt: now } : {}),
      }], now);
    }
  }
  return result;
}
