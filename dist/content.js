(() => {
'use strict';
// A lookup registry, not a persisted-key migration.
const CONCEPT_REGISTRY = {
  generic_name: /^(?:name|your name|applicant name|candidate name)$/,
  first_name: /^(?:first|given|forename) name$/,
  last_name: /^(?:last|family) name$|^surname$/,
  full_name: /^(?:full|complete|legal) name$/,
  preferred_name: /^(?:preferred name|nickname|preferred first name)$/,
  date_of_birth: /^(?:dob|date of birth|birth date|birthday)$/,
  email: /^(?:email|email address|e mail)$/,
  phone: /^(?:phone|phone number|mobile|mobile number|telephone)$/,
  github_url: /^(?:github|github profile|github url)$/,
  linkedin_url: /^(?:linkedin|linkedin profile|linkedin url)$/,
  portfolio_url: /^(?:portfolio|portfolio url|personal website|website)$/,
  current_employer: /^(?:current|present) (?:employer|company|organization)$/,
  current_location: /^(?:current|present) location$/,
  current_city: /^(?:current|present) city$/,
  notice_period: /^(?:notice period|notice duration)$/,
  start_date: /^(?:available start date|earliest start date|start date|date available)$/,
  availability: /^(?:availability|when can you start)$/,
  current_compensation: /^current (?:salary|ctc|compensation)$/,
  expected_compensation: /^(?:expected|desired) (?:salary|ctc|compensation)$/,
};

function conceptForNormalized(text) {
  const cleaned = text.replace(/^(?:(?:what is|please enter|enter) )?(?:your )?/, '').replace(/\blinked in\b/g, 'linkedin').replace(/\bgit hub\b/g, 'github');
  return Object.entries(CONCEPT_REGISTRY).find(([, pattern]) => pattern.test(cleaned))?.[0] || cleaned.replace(/\s+/g, '_');
}


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

function canonicalConcept(value = '') {
  return conceptForNormalized(normalizeText(value));
}

const SENSITIVITIES = new Set(['safe', 'review', 'legal']);

function timestamp(value, fallback = new Date().toISOString()) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : fallback;
}

function normalizeText(value = '') {
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

function slugify(value = '') {
  return normalizeText(value).replace(/\s+/g, '_');
}

function inferSensitivity(question, key = '') {
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

function normalizeAnswerRecord(record = {}) {
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

function suggestionTargetKey(field = {}) {
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

function recordScopeCompatible(field, record) {
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

function meaningCompatible(field, record, { numericReview = true } = {}) {
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

function chooseRecord(field = {}, records = []) {
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

function validateFillValue(field = {}, value) {
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

function shouldReviewDecision(decision = {}, field = {}) {
  return decision.sensitivity !== 'safe'
    || decision.confidence !== 'high'
    || normalizeText(field.type) === 'textarea'
    || String(decision.value ?? '').length > 240;
}

function shouldAutofill(record = {}) {
  return String(record.answer ?? '').trim() !== '' && record.sensitivity === 'safe';
}

function upsertAnswerRecords(existing = [], incoming = [], updatedAt = new Date().toISOString()) {
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

function mergeLearnedAnswers(existing = [], incoming = [], now = new Date().toISOString(), { confirm = false } = {}) {
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


const IGNORED_TYPES = new Set(['hidden', 'password', 'file', 'submit', 'button', 'reset', 'image', 'search']);
const SECRET_MARKER = /(?:password|passcode|passwd|pwd|secret|token|csrf|auth[_-]?token)/i;
const CUSTOM_WIDGET_SELECTOR = '[role="combobox"], button[aria-haspopup="listbox"]';
const EMPTY_CUSTOM_WIDGET_VALUE = /^(?:choose|select)\b/i;
const CUSTOM_WIDGET_PROMPT_LABEL = /^(?:choose|select)(?:\s+(?:one|an?\s+option|an?\s+answer|a\s+value))?$/i;
const trackedDocuments = new WeakSet();
const controlHandles = new WeakMap();
const documentHandles = new WeakMap();

function controlHandle(element) {
  const document = element.ownerDocument;
  const location = document.location?.href || '';
  let state = documentHandles.get(document);
  if (!state || state.location !== location) {
    state = { location, id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, next: 0 };
    documentHandles.set(document, state);
  }
  let handle = controlHandles.get(element);
  if (!handle?.startsWith(`${state.id}:`)) {
    handle = `${state.id}:${++state.next}`;
    controlHandles.set(element, handle);
  }
  return handle;
}

function applicationRoot(document) {
  const candidates = [...document.querySelectorAll('form')].filter(isVisible).map((form) => {
    const label = `${form.id} ${form.getAttribute('aria-label') || ''} ${form.getAttribute('name') || ''} ${form.querySelector('h1,h2,legend')?.textContent || ''}`;
    const action = [...form.querySelectorAll('button,input[type="submit"]')].map(actionLabel).join(' ');
    const score = /subscribe|search|newsletter|alert/i.test(label + action) ? -1
      : (/application|candidate|apply|employment|education/i.test(label) ? 5 : 0) + (/submit application|apply now/i.test(action) ? 3 : 0);
    return { form, score };
  }).sort((a, b) => b.score - a.score);
  if (candidates[0]?.score > 0 && candidates[0].score === candidates[1]?.score) {
    const focused = document.activeElement?.closest?.('form');
    return candidates.some((candidate) => candidate.form === focused && candidate.score === candidates[0].score) ? focused : document.createDocumentFragment();
  }
  return candidates[0]?.score > 0 && candidates[0].score > (candidates[1]?.score ?? -1) ? candidates[0].form : document;
}

function inApplication(document, element) {
  const root = applicationRoot(document);
  if (root !== document) return root.contains(element) || element.form === root;
  const owner = element.closest('form,[role="search"],nav');
  return !owner || !/search|subscribe|newsletter|job.?alert/i.test(`${owner.id} ${owner.getAttribute('role')} ${owner.getAttribute('aria-label') || ''}`);
}

function ensureEditTracking(document) {
  if (trackedDocuments.has(document)) return;
  const markEdited = (event) => {
    let element = event.target;
    if (!element || element.__jobApplicationAutofillDispatch || (document.__jobApplicationFilling && !event.isTrusted)) return;
    if (event.type === 'click') {
      const listbox = element.closest?.('[role="option"]')?.closest('[role="listbox"]');
      if (!listbox?.id) return;
      element = customWidgetElements(document).find((widget) => String(widget.getAttribute('aria-controls') || widget.getAttribute('aria-owns') || '').split(/\s+/).includes(listbox.id));
      if (!element) return;
      delete element.__jobApplicationSearchQuery;
    }
    if (event.type === 'blur' && !element.__jobApplicationUserEdited) return;
    element.__jobApplicationUserEdited = true;
    element.__jobApplicationUserCompleted = event.type !== 'input';
  };
  document.addEventListener('input', markEdited, true);
  document.addEventListener('change', markEdited, true);
  document.addEventListener('blur', markEdited, true);
  document.addEventListener('click', markEdited, true);
  trackedDocuments.add(document);
}

function extractJobContext(document) {
  const readable = (node, limit = 16000) => {
    if (!node || !isVisible(node)) return '';
    const copy = node.cloneNode(true);
    for (const child of copy.querySelectorAll('script,style,nav,footer,form,input,textarea,select,button,[hidden],[aria-hidden="true"]')) child.remove();
    return String(copy.textContent || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  };
  const description = [...document.querySelectorAll('[itemprop="description"],.job-description,#job-description,[data-testid="job-description"],.posting-page .section-wrapper,.posting-description')]
    .map(node => readable(node)).filter(Boolean).join('\n').slice(0, 16000);
  return {
    title: document.title || '', domain: document.location?.hostname || '',
    role: readable(document.querySelector('[itemprop="title"],h1'), 300),
    company: readable(document.querySelector('[itemprop="hiringOrganization"],.company-name'), 300),
    jobDescription: description,
  };
}

function textFromIds(document, ids = '') {
  return String(ids)
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent?.trim() || '')
    .filter(Boolean)
    .join(' ');
}

function labelText(label) {
  const copy = label.cloneNode(true);
  for (const child of copy.querySelectorAll('input,textarea,select,button,[role="combobox"],[role="listbox"]')) child.remove();
  return String(copy.textContent || '').replace(/\s+/g, ' ').trim();
}

function nearbyQuestion(element) {
  const controls = 'input:not([type="hidden"]),textarea,select,[role="combobox"],button[aria-haspopup="listbox"]';
  for (let wrapper = element.parentElement, depth = 0; wrapper && depth < 6; wrapper = wrapper.parentElement, depth++) {
    if (wrapper.matches('form,section,main,body')) break;
    const peers = [...wrapper.querySelectorAll(controls)].filter(isVisible);
    if (peers.some(peer => peer !== element && !(element.type === 'radio' && peer.type === 'radio' && peer.name === element.name))) break;
    const candidates = [...wrapper.querySelectorAll('.application-label .text,h3,h4,[role="heading"],legend,label')]
      .filter(node => isVisible(node) && !node.contains(element) && !node.querySelector(controls)
        && !node.matches('[for]') && !node.closest('[role="alert"],.error,.help,.hint')
        && Boolean(node.compareDocumentPosition(element) & 4));
    const labels = [...new Set(candidates.map(labelText).filter(text => text && text.length <= 500))];
    if (labels.length > 1) return '';
    if (labels.length === 1) return labels[0];
  }
  return '';
}

function questionMetadata(document, element) {
  const native = [...(element.labels || [])].map(labelText).filter(Boolean).join(' ');
  if (element.type === 'radio') {
    const group = element.closest('fieldset,[role="radiogroup"],[role="group"]');
    const explicit = group && (textFromIds(document, group.getAttribute('aria-labelledby')) || group.getAttribute('aria-label') || group.querySelector(':scope > legend')?.textContent?.trim());
    if (explicit) return { label: explicit, labelSource: 'group', labelConfidence: 'high' };
    const peers = radioGroup(document, element);
    const aria = peer => textFromIds(document, peer.getAttribute('aria-labelledby')) || peer.getAttribute('aria-label') || '';
    const shared = aria(element);
    if (shared && peers.length > 1 && peers.every(peer => aria(peer) === shared)) return { label: shared, labelSource: 'shared-aria', labelConfidence: 'high' };
    const nearby = nearbyQuestion(element);
    return { label: nearby || element.name || element.id || '', labelSource: nearby ? 'nearby-question' : 'identity', labelConfidence: nearby ? 'high' : 'low' };
  }
  const explicit = native || element.getAttribute('aria-label') || textFromIds(document, element.getAttribute('aria-labelledby'));
  const nearby = !explicit && nearbyQuestion(element);
  return { label: explicit || nearby || element.getAttribute('placeholder') || element.name || element.id || '',
    labelSource: explicit ? 'explicit' : nearby ? 'nearby-question' : 'identity', labelConfidence: explicit || nearby ? 'high' : 'low' };
}

function labelFor(document, element) {
  if (element.type === 'radio') {
    const legend = element.closest('fieldset')?.querySelector('legend')?.textContent?.trim();
    if (legend) return legend;
  }
  const nativeLabel = [...(element.labels || [])]
    .map(labelText)
    .filter(Boolean)
    .join(' ');
  return nativeLabel
    || element.getAttribute('aria-label')
    || textFromIds(document, element.getAttribute('aria-labelledby'))
    || element.getAttribute('placeholder')
    || element.getAttribute('name')
    || element.id
    || '';
}

function isSupported(element) {
  if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) return false;
  if (element.getAttribute('role') === 'combobox' || element.getAttribute('aria-haspopup') === 'listbox') return false;
  if (element.disabled || element.readOnly) return false;
  if (IGNORED_TYPES.has(String(element.type || '').toLowerCase())) return false;
  return !SECRET_MARKER.test(`${element.name || ''} ${element.id || ''} ${element.autocomplete || ''}`);
}

function isVisible(element) {
  for (let current = element; current; current = current.parentElement) {
    if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false;
    const style = current.getAttribute('style') || '';
    if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style)) return false;
    const computed = current.ownerDocument.defaultView?.getComputedStyle?.(current);
    if (computed && (computed.display === 'none' || computed.visibility === 'hidden' || computed.contentVisibility === 'hidden')) return false;
  }
  return true;
}

function hasNativeFormAction(element) {
  // Use the live native type/form owner: missing or invalid button types submit,
  // and the form attribute can associate a control outside the form subtree.
  const control = element.closest?.('button, input');
  return Boolean(control?.form && ['submit', 'reset', 'image'].includes(control.type));
}

function customWidgetElements(document) {
  return [...document.querySelectorAll(CUSTOM_WIDGET_SELECTOR)]
    .filter((element) => !hasNativeFormAction(element))
    .filter((element) => inApplication(document, element) && !element.disabled && !element.readOnly)
    .filter((element) => isVisible(element))
    .filter((element) => element.closest('form, main, [role="main"]') || hasNearbyFormControl(element))
    .filter((element) => element.getAttribute('aria-label') || element.getAttribute('name')
      || textFromIds(document, element.getAttribute('aria-labelledby')) || associatedLabelText(document, element) || hasNearbyFormControl(element));
}

function hasNearbyFormControl(element) {
  return [...(element.parentElement?.children || [])]
    .some((sibling) => sibling !== element && ['INPUT', 'TEXTAREA', 'SELECT'].includes(sibling.tagName));
}

function customWidgetValue(element) {
  const selectedOptions = customWidgetOptions(element.ownerDocument, element)
    .filter((option) => option.getAttribute('aria-selected') === 'true')
    .map(customOptionText)
    .filter(Boolean);
  const typedValue = element.__jobApplicationSearchQuery || (element.getAttribute('aria-expanded') === 'true' && element.__jobApplicationUserEdited) ? '' : element.value;
  const value = String(selectedOptions.length ? selectedOptions.join(', ') : (element.getAttribute('aria-valuetext') || typedValue || element.textContent || ''))
    .replace(/\s+/g, ' ').trim();
  return EMPTY_CUSTOM_WIDGET_VALUE.test(value) ? '' : value;
}

function customWidgetRequired(element) {
  return element.getAttribute('aria-required') === 'true'
    || /\brequired\b/i.test(element.getAttribute('aria-label') || '')
    || Boolean(element.required);
}

function visibleText(element) {
  return String(element?.textContent || '').replace(/\s+/g, ' ').trim();
}

function associatedLabelText(document, element) {
  const labels = [...(element.labels || [])]
    .map(labelText)
    .filter(Boolean);
  if (labels.length) return labels.join(' ');
  if (!element.id) return '';
  const explicit = [...document.querySelectorAll('label')]
    .filter((label) => label.getAttribute('for') === element.id)
    .map((label) => visibleText(label))
    .filter(Boolean);
  return explicit.join(' ');
}

function nearestFieldGroupLabel(element) {
  const group = element.closest('fieldset, [role="group"]');
  if (!group) return '';
  for (const current of [group]) {
    const candidates = [...current.querySelectorAll('label, legend')]
      .map((candidate) => visibleText(candidate))
      .filter(Boolean);
    const unique = [...new Set(candidates)];
    if (unique.length === 1) return unique[0];
  }
  return '';
}

function fieldContext(element) {
  const group = element.closest('fieldset, [role="group"], section, form');
  if (!group) return {};
  const heading = group.querySelector(':scope > legend, :scope > h1, :scope > h2, :scope > h3, :scope > [role="heading"]');
  const section = visibleText(heading);
  const contextText = `${section} ${group.id} ${group.getAttribute('data-automation-id') || ''}`;
  const entityType = /employment|work.?experience|work.?history/i.test(contextText) ? 'employment'
    : /education|school|university/i.test(contextText) ? 'education' : '';
  const entityId = group.getAttribute('data-entity-id') || (entityType || /reference|referee|emergency|supervisor/i.test(contextText) ? group.id || group.getAttribute('name') : '')
    || (entityType ? `${entityType}-${[...element.ownerDocument.querySelectorAll('fieldset,[role="group"],section')].indexOf(group) + 1}` : '');
  return {
    ...(section ? { section } : {}),
    ...(entityId ? { entityId } : {}),
    ...(entityType ? { entityType } : {}),
  };
}

function customWidgetLabel(document, element) {
  const associated = associatedLabelText(document, element);
  if (associated) return associated;
  const labelledBy = textFromIds(document, element.getAttribute('aria-labelledby'));
  if (labelledBy) return labelledBy;
  const fieldGroupLabel = nearestFieldGroupLabel(element) || nearbyQuestion(element);
  if (fieldGroupLabel) return fieldGroupLabel;

  const displayed = customWidgetValue(element);
  const ariaLabel = String(element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
  const withoutState = ariaLabel.replace(/\b(?:required|optional)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const normalizedLabel = normalizeText(withoutState);
  const normalizedValue = normalizeText(displayed);
  const withoutValue = displayed && normalizedLabel.endsWith(normalizedValue)
    ? withoutState.slice(0, withoutState.length - displayed.length).replace(/[,:-]\s*$/, '').trim()
    : withoutState;
  const fallback = withoutValue && !CUSTOM_WIDGET_PROMPT_LABEL.test(withoutValue)
    ? withoutValue
    : '';
  return fallback || (ariaLabel && !CUSTOM_WIDGET_PROMPT_LABEL.test(ariaLabel.replace(/\b(?:required|optional)\b/gi, ' ').replace(/\s+/g, ' ').trim()) ? ariaLabel : '')
    || element.getAttribute('name') || element.id || '';
}

function customOptionText(element) {
  return String(element.textContent || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
}

function customOptionValue(element) {
  return String(element.getAttribute('data-value') || element.getAttribute('value') || '').trim();
}

function customOptionAliases(option) {
  const label = customOptionText(option);
  // SuccessFactors picklists prefix display labels with an ordinal ("4 - Bachelor's degree").
  const unnumbered = option.closest('.sf-list-select') ? label.replace(/^\d+\s+[-–—]\s+(?=[A-Za-z])/, '') : label;
  return [label, unnumbered, customOptionValue(option)].filter(Boolean).map(normalizeText);
}

function matchingCustomOptions(options, value) {
  const exact = options.filter((option) => [customOptionText(option), customOptionValue(option)].map(normalizeText).includes(value));
  return exact.length ? exact : options.filter((option) => customOptionAliases(option).includes(value));
}

function customWidgetOptions(document, element) {
  const ids = String(element.getAttribute('aria-controls') || element.getAttribute('aria-owns') || '').split(/\s+/).filter(Boolean);
  const listboxes = ids.length
    ? ids.map((id) => document.getElementById(id)).filter(Boolean).flatMap((node) => node.matches('[role="listbox"]') ? [node] : [...node.querySelectorAll('[role="listbox"]')])
    : [...document.querySelectorAll('[role="listbox"]')];
  const visibleListboxes = listboxes
    .filter((listbox) => isVisible(listbox))
    .filter((listbox) => ids.length || (listboxes.length === 1 && ![...document.querySelectorAll(CUSTOM_WIDGET_SELECTOR)].some((owner) => owner !== element && String(owner.getAttribute('aria-controls') || owner.getAttribute('aria-owns') || '').split(/\s+/).includes(listbox.id))));
  return visibleListboxes
    .flatMap((listbox) => [...listbox.querySelectorAll('[role="option"]')])
    .filter((option) => isVisible(option) && option.getAttribute('aria-disabled') !== 'true' && !option.disabled);
}

function fieldIdentity(element, index, collection = []) {
  const base = element.id || element.name || `field_${controlHandle(element)}`;
  if (!element.id && !element.name) return base;
  const occurrence = collection.slice(0, index + 1)
    .filter((candidate) => (candidate.id || candidate.name || '') === base).length;
  return occurrence > 1 ? `${base}__${controlHandle(element)}` : base;
}

function checkboxChoiceGroup(document, element) {
  if (element.type !== 'checkbox') return null;
  for (let container = element.parentElement, depth = 0; container && depth < 5; container = container.parentElement, depth += 1) {
    if (container.matches('form,main,body')) break;
    const members = [...container.querySelectorAll('input[type="checkbox"]')]
      .filter((candidate) => isSupported(candidate) && isVisible(candidate) && inApplication(document, candidate));
    if (members.length < 2 || !members.includes(element)) continue;
    const controls = [...container.querySelectorAll('input:not([type="hidden"]),textarea,select')]
      .filter((candidate) => isSupported(candidate) && isVisible(candidate));
    if (controls.some((candidate) => candidate.type !== 'checkbox')) continue;
    const heading = [...container.children].filter((candidate) => {
      if (candidate.matches('legend,h1,h2,h3,h4,[role="heading"]')) return true;
      // A direct label without controls is a common hosted-form question wrapper.
      // Exclude option labels so grouping still requires one unambiguous question.
      return candidate.tagName === 'LABEL'
        && !candidate.htmlFor
        && !candidate.querySelector('input,textarea,select');
    }).filter(isVisible);
    if (heading.length !== 1) continue;
    const label = visibleText(heading[0]);
    if (!label) continue;
    if (!(heading[0].compareDocumentPosition(members[0]) & 4)) continue;
    return { container, members, label };
  }
  return null;
}

function choiceOption(element, index) {
  const label = optionText(element);
  const value = String(element.value || label);
  return {
    key: choiceOptionKey(index, element.id || element.name || value || label),
    label,
    value,
    selected: Boolean(element.checked),
    disabled: Boolean(element.disabled),
  };
}

function choiceOptionKey(index, identity) {
  return `option_${index}_${slugify(identity || 'choice')}`;
}

function normalizedChoiceOption({ label, value, selected, disabled }, index) {
  return {
    key: choiceOptionKey(index, value || label),
    label: String(label || ''),
    value: String(value || label || ''),
    selected: Boolean(selected),
    disabled: Boolean(disabled),
  };
}

function choiceMetadata(document, element) {
  if (element.tagName === 'SELECT') {
    const options = [...element.options].map((option, index) => normalizedChoiceOption({
      label: option.textContent.trim(), value: option.value, selected: option.selected, disabled: option.disabled,
    }, index));
    return { control: 'select', multiple: Boolean(element.multiple), options };
  }
  if (element.type === 'radio') {
    const options = radioGroup(document, element).map((option, index) => normalizedChoiceOption({
      label: optionText(option), value: option.value, selected: option.checked, disabled: option.disabled,
    }, index));
    return { control: 'radio', multiple: false, options };
  }
  if (customWidgetElements(document).includes(element)) {
    const options = customWidgetOptions(document, element).map((option, index) => normalizedChoiceOption({
      label: customOptionText(option), value: customOptionValue(option), selected: option.getAttribute('aria-selected') === 'true', disabled: option.getAttribute('aria-disabled') === 'true' || option.disabled,
    }, index));
    const multiple = element.getAttribute('aria-multiselectable') === 'true'
      || customWidgetOptions(document, element)[0]?.closest('[role="listbox"]')?.getAttribute('aria-multiselectable') === 'true';
    return { control: 'custom', multiple, options };
  }
  return null;
}

function checkboxChoiceDescriptor(document, element, index, group) {
  const options = group.members.map(choiceOption);
  const selected = options.filter((option) => option.selected);
  return {
    id: fieldIdentity(element, index, formElements(document)),
    handle: controlHandle(element),
    multiple: true,
    selectedOptionKeys: selected.map((option) => option.key),
    choice: { control: 'checkbox', multiple: true, options },
    label: group.label,
    labelSource: 'group',
    labelConfidence: 'high',
    helpText: textFromIds(document, element.getAttribute('aria-describedby')).slice(0, 2000),
    nearbyContext: nearbyQuestion(element).slice(0, 1000),
    type: 'choice',
    autocomplete: '',
    placeholder: '',
    required: group.members.some((member) => member.required),
    currentValue: selected.map((option) => option.label).join(', '),
    options: options.map((option) => option.label),
    constraints: {},
    ...fieldContext(element),
  };
}

function formElements(document) {
  return [...document.querySelectorAll('input, textarea, select')].filter((element) => isSupported(element) && isVisible(element) && inApplication(document, element));
}

function uniqueFields(document) {
  const fields = [];
  const seenRadioGroups = new Set();
  const seenCheckboxGroups = new Set();
  for (const [index, element] of formElements(document).entries()) {
    if (element.type === 'radio' && element.name) {
      const group = radioGroup(document, element)[0];
      if (seenRadioGroups.has(group)) continue;
      seenRadioGroups.add(group);
    }
    const checkboxGroup = checkboxChoiceGroup(document, element);
    if (checkboxGroup) {
      if (seenCheckboxGroups.has(checkboxGroup.container)) continue;
      seenCheckboxGroups.add(checkboxGroup.container);
      fields.push({ element: checkboxGroup.members[0], index, checkboxGroup });
      continue;
    }
    fields.push({ element, index });
  }
  return fields;
}

function fieldOptions(document, element) {
  if (customWidgetElements(document).includes(element)) {
    return customWidgetOptions(document, element)
      .flatMap((option) => [customOptionText(option), customOptionValue(option)])
      .filter(Boolean)
      .filter((option, index, options) => options.findIndex((candidate) => normalizeText(candidate) === normalizeText(option)) === index);
  }
  if (element.tagName === 'SELECT') {
    return [...element.options]
      .flatMap((option) => [option.textContent.trim(), option.value.trim()])
      .filter(Boolean)
      .filter((option, index, options) => options.findIndex((candidate) => normalizeText(candidate) === normalizeText(option)) === index);
  }
  if (element.type === 'radio') {
    const group = radioGroup(document, element);
    return group.map((candidate) => optionText(candidate)).filter(Boolean);
  }
  if (element.type === 'checkbox') return ['Yes', 'No'];
  return [];
}

function optionText(element) {
  const label = [...(element.labels || [])].map((item) => item.textContent || '').join(' ').trim();
  return label || element.getAttribute('aria-label') || element.value || '';
}

function fieldValue(document, element) {
  if (customWidgetElements(document).includes(element)) return customWidgetValue(element);
  if (element.type === 'checkbox') {
    return element.checked ? 'Yes' : (element.__jobApplicationUserEdited || element.__jobApplicationAutofillValue != null ? 'No' : '');
  }
  if (element.type === 'radio') {
    const selected = radioGroup(document, element).find((candidate) => candidate.checked);
    return selected ? optionText(selected) : '';
  }
  if (element.tagName === 'SELECT') {
    if (element.multiple) return [...element.selectedOptions].filter((option) => option.value).map((option) => option.textContent.trim()).join(', ');
    const selected = element.selectedOptions?.[0];
    return selected?.value && !selected.disabled ? selected.textContent.trim() : '';
  }
  return String(element.value || '').trim();
}

function constraintsFor(element) {
  const constraints = {};
  for (const attribute of ['min', 'max', 'pattern']) {
    if (element.hasAttribute(attribute)) constraints[attribute] = element.getAttribute(attribute);
  }
  for (const attribute of ['minLength', 'maxLength']) {
    const htmlAttribute = attribute.toLowerCase();
    if (element.hasAttribute(htmlAttribute)) constraints[attribute] = Number(element.getAttribute(htmlAttribute));
  }
  return constraints;
}

function describeField(document, element, index, checkboxGroup = null) {
  if (checkboxGroup) return checkboxChoiceDescriptor(document, element, index, checkboxGroup);
  const type = element.tagName === 'SELECT' ? 'select' : element.tagName === 'TEXTAREA' ? 'textarea' : (element.type || 'text');
  const choice = choiceMetadata(document, element);
  return {
    id: fieldIdentity(element, index, formElements(document)),
    handle: controlHandle(element),
    multiple: Boolean(element.multiple),
    ...(choice ? { choice, selectedOptionKeys: choice.options.filter((option) => option.selected).map((option) => option.key), multiple: choice.multiple } : {}),
    selectedValues: element.tagName === 'SELECT' ? [...element.selectedOptions].filter((option) => option.value).map((option) => option.value) : [],
    structuredOptions: element.tagName === 'SELECT' ? [...element.options].map((option) => ({ label: option.textContent.trim(), value: option.value, selected: option.selected, disabled: option.disabled })) : [],
    ...questionMetadata(document, element),
    helpText: textFromIds(document, element.getAttribute('aria-describedby')).slice(0, 2000),
    nearbyContext: nearbyQuestion(element).slice(0, 1000),
    type,
    autocomplete: element.autocomplete || '',
    placeholder: element.getAttribute('placeholder') || '',
    required: Boolean(element.required),
    currentValue: fieldValue(document, element),
    options: fieldOptions(document, element),
    constraints: constraintsFor(element),
    ...fieldContext(element),
  };
}

function collectFieldDescriptors(document) {
  ensureEditTracking(document);
  const nativeFields = uniqueFields(document).map(({ element, index, checkboxGroup }) => ({ element, field: describeField(document, element, index, checkboxGroup) }));
  const customElements = customWidgetElements(document);
  const customFields = customElements
    .filter((element, index) => !nativeFields.some(({ field }) => field.id === fieldIdentity(element, index, customElements)))
    .map((element, index) => {
      const choice = choiceMetadata(document, element);
      return { element, field: {
      id: fieldIdentity(element, index, customElements),
      handle: controlHandle(element),
      multiple: choice?.multiple || false,
      choice,
      selectedOptionKeys: choice?.options.filter((option) => option.selected).map((option) => option.key) || [],
      structuredOptions: customWidgetOptions(document, element).map((option) => ({ label: customOptionText(option), value: customOptionValue(option), selected: option.getAttribute('aria-selected') === 'true', disabled: option.getAttribute('aria-disabled') === 'true' })),
      label: customWidgetLabel(document, element),
      labelSource: nearbyQuestion(element) === customWidgetLabel(document, element) ? 'nearby-question' : 'custom-widget',
      labelConfidence: customWidgetLabel(document, element) && ![element.name, element.id].includes(customWidgetLabel(document, element)) ? 'high' : 'low',
      type: 'select',
      widget: 'custom',
      autocomplete: element.getAttribute('autocomplete') || '',
      required: customWidgetRequired(element),
      currentValue: fieldValue(document, element),
      options: fieldOptions(document, element),
      constraints: {},
      ...fieldContext(element),
    } };
    });
  const fields = [...nativeFields, ...customFields]
    .sort(({ element: left }, { element: right }) => {
      const position = left.compareDocumentPosition?.(right) || 0;
      if (position & 4) return -1;
      if (position & 2) return 1;
      return 0;
    })
    .map(({ field }, formOrder) => ({ ...field, formOrder }));
  const groupKey = (field) => `${canonicalConcept(field.label)}:${field.entityId || ''}`;
  const counts = new Map();
  const occurrences = new Map();
  for (const field of fields) counts.set(groupKey(field), (counts.get(groupKey(field)) || 0) + 1);
  return fields.map((field) => {
    const key = groupKey(field);
    const occurrence = (occurrences.get(key) || 0) + 1;
    occurrences.set(key, occurrence);
    return counts.get(key) > 1 ? { ...field, entityId: `${field.entityId || 'entry'}-${occurrence}` } : field;
  });
}

function dispatchFormEvents(element) {
  const view = element.ownerDocument.defaultView;
  element.__jobApplicationAutofillDispatch = true;
  try {
    for (const eventName of ['input', 'change', 'blur']) {
      element.dispatchEvent(new view.Event(eventName, { bubbles: true }));
    }
  } finally {
    delete element.__jobApplicationAutofillDispatch;
  }
}

function setTextValue(element, value) {
  const view = element.ownerDocument.defaultView;
  const prototype = element.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement?.prototype : view.HTMLInputElement?.prototype;
  const setter = prototype && Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter) setter.call(element, String(value));
  else element.value = String(value);
  dispatchFormEvents(element);
  return element.value === String(value);
}

function checkValidityWithoutPattern(element) {
  const pattern = element.getAttribute('pattern');
  element.removeAttribute('pattern');
  try {
    return element.checkValidity();
  } finally {
    element.setAttribute('pattern', pattern);
  }
}

function checkValiditySafely(element) {
  if (typeof element?.checkValidity !== 'function') return true;
  const pattern = element.getAttribute('pattern');
  if (pattern !== null) {
    // HTML patterns use Unicode Sets mode. Chrome can log a malformed pattern
    // from checkValidity even when it does not throw an exception to our caller.
    let invalidPattern = false;
    try {
      new RegExp(pattern, 'v');
    } catch {
      invalidPattern = true;
    }
    if (invalidPattern) return checkValidityWithoutPattern(element);
  }
  try {
    return element.checkValidity();
  } catch (error) {
    const message = String(error?.message || '');
    const isInvalidPattern = element.hasAttribute('pattern')
      && (error?.name === 'SyntaxError' || /invalid regular expression|regular expression/i.test(message));
    if (!isInvalidPattern) throw error;

    return checkValidityWithoutPattern(element);
  }
}

function setSelectValue(element, answer) {
  if (element.multiple) {
    const values = String(answer).split(/\s*[,;]\s*/).map(normalizeText);
    const matches = [...element.options].filter((option) => !option.disabled && values.some((value) => [normalizeText(option.value), normalizeText(option.textContent)].includes(value)));
    if (matches.length !== values.length) return false;
    for (const option of element.options) option.selected = matches.includes(option);
    dispatchFormEvents(element);
    return [...element.selectedOptions].length === matches.length;
  }
  const expected = normalizeText(answer);
  const option = [...element.options].find((candidate) => normalizeText(candidate.value) === expected || normalizeText(candidate.textContent) === expected);
  if (!option) return false;
  element.value = option.value;
  dispatchFormEvents(element);
  return element.value === option.value;
}

function radioGroup(document, element) {
  return formElements(document).filter((candidate) => candidate.type === 'radio' && (element.name ? candidate.name === element.name && candidate.form === element.form : candidate === element));
}

function setRadioGroup(document, element, answer) {
  const expected = normalizeText(answer);
  const option = radioGroup(document, element).find((candidate) => normalizeText(candidate.value) === expected || normalizeText(optionText(candidate)) === expected);
  if (!option) return false;
  option.checked = true;
  dispatchFormEvents(option);
  return option.checked;
}

function setCheckbox(element, answer) {
  const expected = normalizeText(answer);
  if (!['yes', 'true', 'checked', 'no', 'false', 'unchecked'].includes(expected)) return false;
  element.checked = ['yes', 'true', 'checked'].includes(expected);
  dispatchFormEvents(element);
  return true;
}

function requestedCustomValues(answer, multiple) {
  if (Array.isArray(answer)) return answer.map(normalizeText).filter(Boolean);
  return (multiple ? String(answer).split(/\s*[,;]\s*/) : [answer]).map(normalizeText).filter(Boolean);
}

function waitForCustomOptions(document, element, answer, timeoutMs = 1500) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      const options = customWidgetOptions(document, element);
      const multiple = element.getAttribute('aria-multiselectable') === 'true'
        || options[0]?.closest('[role="listbox"]')?.getAttribute('aria-multiselectable') === 'true';
      const requested = requestedCustomValues(answer, multiple);
      if ((options.length && requested.every((value) => matchingCustomOptions(options, value).length)) || Date.now() - startedAt >= timeoutMs) {
        resolve(options);
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

async function setCustomChoiceValue(document, element, answer) {
  element.focus?.();
  if (hasNativeFormAction(element)) {
    return { ok: false, unresolved: true, reason: 'Refusing to activate a native submit/reset control' };
  }
  if (element.getAttribute('aria-expanded') !== 'true') element.click();
  const searchAnswer = Array.isArray(answer) ? answer[0] : answer;
  const expected = normalizeText(searchAnswer);
  if (element.tagName === 'INPUT' && element.getAttribute('aria-autocomplete')) {
    element.__jobApplicationSearchQuery = true;
    setTextValue(element, searchAnswer);
  }
  const options = await waitForCustomOptions(document, element, answer);
  if (!options.length) {
    if (element.tagName === 'INPUT') setTextValue(element, '');
    return { ok: false, unresolved: true, reason: 'The custom widget did not reveal any options' };
  }
  const multiple = element.getAttribute('aria-multiselectable') === 'true'
    || options[0]?.closest('[role="listbox"]')?.getAttribute('aria-multiselectable') === 'true';
  const requested = requestedCustomValues(answer, multiple);
  const candidates = requested.map((value) => matchingCustomOptions(options, value));
  const matches = candidates.flat();
  if (candidates.some((options) => options.length !== 1) || new Set(matches).size !== matches.length) {
    return { ok: false, unresolved: true, reason: 'The custom widget does not expose one unique exact option' };
  }
  if (multiple) {
    for (const option of options) {
      if (option.getAttribute('aria-selected') !== 'true' || matches.includes(option)) continue;
      if (hasNativeFormAction(option)) return { ok: false, unresolved: true, reason: 'Refusing to activate a native submit/reset option' };
      option.click();
    }
  }
  for (const match of matches) {
    if (match.getAttribute('aria-selected') === 'true') continue;
    // Recheck after awaiting options and after every preceding selection.
    if (hasNativeFormAction(match)) {
      return { ok: false, unresolved: true, reason: 'Refusing to activate a native submit/reset option' };
    }
    match.click();
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  const backingInput = [...(element.parentElement?.querySelectorAll('input, textarea') || [])].find((input) => input !== element);
  const acceptedSingleValues = multiple ? [expected] : [...new Set([expected, ...customOptionAliases(matches[0])])];
  if (element.tagName === 'INPUT') {
    const committed = matches.every((option) => option.getAttribute('aria-selected') === 'true')
      || acceptedSingleValues.includes(normalizeText(element.getAttribute('aria-valuetext')))
      || acceptedSingleValues.includes(normalizeText(backingInput?.value || ''))
      || (element.getAttribute('aria-expanded') === 'false' && acceptedSingleValues.includes(normalizeText(element.value)));
    if (!committed) return { ok: false, unresolved: true, reason: 'The searchable widget has no committed selection' };
    delete element.__jobApplicationSearchQuery;
  }
  if (backingInput) dispatchFormEvents(backingInput);
  dispatchFormEvents(element);
  const displayed = normalizeText(fieldValue(document, element));
  const backingValue = normalizeText(backingInput?.value || '');
  const displayedMatches = multiple
    ? options.filter((option) => option.getAttribute('aria-selected') === 'true').length === matches.length
      && matches.every((option) => option.getAttribute('aria-selected') === 'true')
    : acceptedSingleValues.includes(displayed) || acceptedSingleValues.includes(backingValue);
  if (!displayedMatches && backingValue !== expected) {
    return { ok: false, unresolved: true, reason: 'The custom widget did not accept the selected option' };
  }
  return { ok: true };
}

async function fillElement(document, element, answer) {
  if (!element) return { ok: false, reason: 'The field control is no longer available' };
  element.__jobApplicationAutofillValue = String(answer);
  delete element.__jobApplicationUserEdited;
  if (customWidgetElements(document).includes(element)) return setCustomChoiceValue(document, element, answer);
  if (element.tagName === 'SELECT') return { ok: setSelectValue(element, answer) };
  if (element.type === 'radio') return { ok: setRadioGroup(document, element, answer) };
  if (element.type === 'checkbox') return { ok: setCheckbox(element, answer) };
  return { ok: setTextValue(element, answer) };
}

async function setChoiceSelection(document, field, selectedOptionKeys) {
  if (!field?.choice || !Array.isArray(selectedOptionKeys)) return { ok: false, reason: 'The choice selection is unavailable' };
  const requested = [...new Set(selectedOptionKeys.filter((key) => typeof key === 'string' && key))];
  const options = field.choice.options || [];
  if (requested.length !== selectedOptionKeys.length || requested.some((key) => !options.some((option) => option.key === key))) {
    return { ok: false, reason: 'The selected options are no longer available' };
  }
  if (!field.multiple && requested.length !== 1) return { ok: false, reason: 'Select exactly one option' };
  const element = elementForField(document, field.id);
  const expected = new Set(requested);
  if (field.choice.control === 'checkbox') {
    const group = element && checkboxChoiceGroup(document, element);
    if (!group || group.members.length !== options.length) return { ok: false, reason: 'The choice controls changed on the page' };
    for (const [index, member] of group.members.entries()) {
      const option = choiceOption(member, index);
      if (member.disabled && expected.has(option.key) && !member.checked) return { ok: false, reason: 'A selected option is disabled' };
      const selected = expected.has(option.key);
      if (member.checked === selected) continue;
      member.checked = selected;
      dispatchFormEvents(member);
    }
  } else if (field.choice.control === 'select' && element?.tagName === 'SELECT') {
    const liveOptions = [...element.options];
    if (liveOptions.length !== options.length) return { ok: false, reason: 'The choice controls changed on the page' };
    for (const [index, option] of liveOptions.entries()) {
      const key = normalizedChoiceOption({ label: option.textContent.trim(), value: option.value }, index).key;
      if (option.disabled && expected.has(key) && !option.selected) return { ok: false, reason: 'A selected option is disabled' };
      option.selected = expected.has(key);
    }
    dispatchFormEvents(element);
  } else if (field.choice.control === 'radio' && element) {
    const members = radioGroup(document, element);
    if (members.length !== options.length) return { ok: false, reason: 'The choice controls changed on the page' };
    const selected = members.find((member, index) => expected.has(normalizedChoiceOption({ label: optionText(member), value: member.value }, index).key));
    if (!selected || selected.disabled) return { ok: false, reason: 'The selected option is unavailable' };
    selected.checked = true;
    dispatchFormEvents(selected);
  } else if (field.choice.control === 'custom' && element) {
    const selected = options.filter((option) => expected.has(option.key));
    const applied = await setCustomChoiceValue(document, element, selected.map((option) => option.value || option.label));
    if (!applied.ok) return applied;
  } else {
    return { ok: false, reason: 'The choice control is unavailable' };
  }
  const refreshed = currentField(document, field.id);
  if (!refreshed?.choice || refreshed.selectedOptionKeys.length !== requested.length
    || refreshed.selectedOptionKeys.some((key) => !expected.has(key))) {
    return { ok: false, reason: 'The page did not retain the selected options' };
  }
  return { ok: true };
}

function elementsForField(document, fieldId) {
  const nativeElements = formElements(document);
  const nativeMatch = nativeElements.find((element, index) => fieldIdentity(element, index, nativeElements) === fieldId);
  if (nativeMatch) return [nativeMatch];
  const customFields = customWidgetElements(document);
  const generatedCustomIndex = customFields.findIndex((element, index) => fieldIdentity(element, index, customFields) === fieldId);
  if (generatedCustomIndex >= 0) return [customFields[generatedCustomIndex]];
  const byId = document.getElementById(fieldId);
  if (byId && (isSupported(byId) || customFields.includes(byId))) return [byId];
  return [...nativeElements, ...customFields]
    .filter((element) => element.name === fieldId || element.id === fieldId);
}

function elementForField(document, fieldId) {
  return elementsForField(document, fieldId)[0] || null;
}

function currentField(document, fieldId) {
  return collectFieldDescriptors(document).find((field) => field.id === fieldId) || null;
}

async function revealChoiceOptions(document, fieldId) {
  const field = currentField(document, fieldId);
  if (!field?.choice || field.choice.control !== 'custom') return field;
  if (field.choice.options.length) return field;
  const element = elementForField(document, fieldId);
  if (!element || hasNativeFormAction(element)) return null;
  element.focus?.();
  if (element.getAttribute('aria-expanded') !== 'true') element.click();
  await waitForCustomOptions(document, element, []);
  return currentField(document, fieldId);
}

function effectiveSensitivity(field, decision) {
  const inferred = inferSensitivity(field.label, field.id);
  if (inferred === 'legal' || decision.sensitivity === 'legal') return 'legal';
  if (inferred === 'review' || decision.sensitivity === 'review') return 'review';
  return 'safe';
}

function addReviewIfNeeded(result, field, decision, value) {
  const effective = { ...decision, sensitivity: effectiveSensitivity(field, decision), value };
  if (value && shouldReviewDecision(effective, field)) result.reviewRequired.push({ ...effective, field });
}

function isExplicitCoverField(field = {}) {
  const label = normalizeText(`${field.label || ''} ${field.name || ''} ${field.id || ''}`);
  return /\bcover letter\b|\bcover message\b|\bmessage to hiring manager\b|\bnote to recruiter\b|\brecruiter message\b/.test(label);
}

function coverMessageDecision(field, coverMessages = []) {
  if (!isExplicitCoverField(field)) return null;
  const template = coverMessages.find((message) => String(message.body || '').trim());
  if (!template) return null;
  return {
    fieldId: field.id,
    action: 'fill',
    value: template.body,
    evidenceKeys: [`cover_message:${template.id}`],
    confidence: 'high',
    sensitivity: 'review',
    reason: 'Imported cover-message template; review before submitting',
  };
}

function hiringCompanyDefault(field, profile = {}, page = {}) {
  const text = normalizeText(`${field.label || ''} ${field.name || ''} ${field.id || ''}`);
  // Do not turn referrals, professional references, or broad declarations
  // into company-relationship answers.
  if (/referr|professional reference|reference contact|conflict of interest/.test(text)) return null;
  // ATS pages commonly expose the employer in the title ("Acme Careers —
  // Apply"). Use only that deliberate title shape; a generic page title stays
  // unresolved rather than receiving a guess.
  const titleCompany = String(page.title || '').match(/^\s*(.+?)\s+(?:careers?|jobs?)\b/i)?.[1] || '';
  const company = normalizeText(field.targetCompany || page.company || titleCompany);
  if (!company) return null;
  const employer = (profile.employment || []).find((entry) => normalizeText(entry.company) === company);
  if (/have you (?:ever |previously )?worked (?:at|for|with)|former employee|prior employment/.test(text)) {
    return employer ? { value: 'Yes', reason: 'Confirmed prior employer' } : { value: 'No', reason: 'No prior employment at this company' };
  }
  if (/relative|family member|related to/.test(text)) {
    return { value: profile.defaults?.relatedToHiringCompany || 'No', reason: 'Profile company-relationship default' };
  }
  if (/know (?:anyone|someone)|friends? (?:or )?contacts?|any contacts? (?:at|in)/.test(text)) {
    return { value: profile.defaults?.knownAtHiringCompany || 'No', reason: 'Profile company-contact default' };
  }
  return null;
}

function planDeterministicFill(fields, records, coverMessages = [], profile = {}, page = {}) {
  return fields.map((field) => {
    const coverDecision = coverMessageDecision(field, coverMessages);
    if (coverDecision) return coverDecision;
    const match = chooseRecord(field, records);
    if (!match) {
      const defaultAnswer = hiringCompanyDefault(field, profile, page);
      if (defaultAnswer) return {
        fieldId: field.id,
        action: 'fill',
        value: defaultAnswer.value,
        evidenceKeys: [],
        confidence: 'high',
        sensitivity: 'review',
        reason: defaultAnswer.reason,
      };
      if (['full_name', 'generic_name'].includes(canonicalConcept(field.label))) {
        const first = chooseRecord({ ...field, label: 'First name', autocomplete: '', id: '', name: '', placeholder: '' }, records);
        const last = chooseRecord({ ...field, label: 'Last name', autocomplete: '', id: '', name: '', placeholder: '' }, records);
        if (first && last) return { fieldId: field.id, action: 'fill', value: `${first.record.answer} ${last.record.answer}`, evidenceKeys: [first.record.key, last.record.key], confidence: 'high', sensitivity: inferSensitivity(field.label), transformation: 'compose_name', reason: 'Composed from known first and last names' };
      }
      return {
        fieldId: field.id,
        action: 'ask_user',
        value: null,
        evidenceKeys: [],
        confidence: 'low',
        sensitivity: inferSensitivity(field.label, field.id),
        reason: 'No local answer matched this field',
      };
    }
    return {
      fieldId: field.id,
      action: 'fill',
      value: match.record.answer,
      evidenceKeys: [match.record.key],
      confidence: match.confidence === 'exact' ? 'high' : match.confidence,
      sensitivity: match.record.sensitivity || inferSensitivity(field.label, field.id),
      reason: match.reason,
    };
  }).map((decision, index) => ({ ...decision, handle: fields[index].handle }));
}

async function applyDecisions(document, decisions = []) {
  const result = { applied: [], kept: [], reviewRequired: [], unresolved: [], failed: [] };
  for (const decision of decisions) {
    try {
    const field = currentField(document, decision.fieldId);
    if (!field || (decision.handle && decision.handle !== field.handle)) {
      result.failed.push({ fieldId: decision.fieldId, reason: 'Field is no longer on the page' });
      continue;
    }
    const element = elementForField(document, decision.fieldId);
    if (decision.action === 'select_choice') {
      document.__jobApplicationFilling = true;
      const fillResult = await setChoiceSelection(document, field, decision.selectedOptionKeys);
      if (!fillResult.ok) {
        result.failed.push({ fieldId: field.id, label: field.label, reason: fillResult.reason });
        continue;
      }
      const refreshed = currentField(document, field.id);
      result.applied.push({ ...decision, field: refreshed, value: refreshed.currentValue });
      addReviewIfNeeded(result, refreshed, decision, refreshed.currentValue);
      continue;
    }
    if (decision.action === 'keep') {
      result.kept.push({ fieldId: field.id, value: field.currentValue });
      addReviewIfNeeded(result, field, decision, field.currentValue);
      continue;
    }
    if (decision.action === 'ask_user') {
      result.unresolved.push({ fieldId: field.id, label: field.label, reason: decision.reason });
      addReviewIfNeeded(result, field, decision, field.currentValue);
      continue;
    }
    if (decision.action !== 'fill') {
      result.unresolved.push({ fieldId: field.id, label: field.label, reason: decision.reason || 'Unsupported decision action' });
      continue;
    }
    const current = field.currentValue;
    if (current && validateFillValue(field, current).ok) {
      result.kept.push({ fieldId: field.id, value: current });
      addReviewIfNeeded(result, field, decision, current);
      continue;
    }
    // Custom options may be filtered, stale, or loaded only after opening/searching.
    // Validate their exact match against the live popup in setCustomChoiceValue.
    const validation = validateFillValue(field.widget === 'custom' ? { ...field, options: [] } : field, decision.value);
    if (!validation.ok) {
      result.failed.push({ fieldId: field.id, label: field.label, value: decision.value, reason: validation.reason });
      continue;
    }
    document.__jobApplicationFilling = true;
    const fillResult = await fillElement(document, element, decision.value);
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (!element.isConnected || !checkValiditySafely(element) || (field.widget !== 'custom' && !fieldValue(document, element))) {
      result.failed.push({ fieldId: field.id, reason: 'The control did not retain a valid value' });
      continue;
    }
    if (!fillResult?.ok) {
      const issue = { fieldId: field.id, label: field.label, value: decision.value, reason: fillResult?.reason || 'The page rejected this value' };
      if (fillResult?.unresolved) result.unresolved.push(issue);
      else result.failed.push(issue);
      continue;
    }
    const applied = { ...decision, field, value: decision.value };
    result.applied.push(applied);
    addReviewIfNeeded(result, field, decision, decision.value);
    } catch (error) {
      result.failed.push({ fieldId: decision.fieldId, reason: error.message });
    } finally { document.__jobApplicationFilling = false; }
  }
  return result;
}

function actionLabel(element) {
  return String(element.textContent || element.value || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
}

function actionKind(element, label = actionLabel(element)) {
  const type = String(element.type || '').toLowerCase();
  const nextLabel = /^(next|continue|save and continue|proceed|review application|next step)\b/i.test(label);
  const formControl = element.tagName === 'BUTTON' || element.tagName === 'INPUT';
  return nextLabel
    ? 'next'
    : formControl && /\b(submit|apply|finish|complete application|send application)\b/i.test(label)
      ? 'submit'
      : 'other';
}

function collectActions(document) {
  const actions = [];
  const candidates = [...document.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"]')];
  for (const [index, element] of candidates.entries()) {
    if (element.disabled || !isVisible(element) || !inApplication(document, element)) continue;
    const label = actionLabel(element);
    if (!label) continue;
    const type = String(element.type || '').toLowerCase();
    const kind = actionKind(element, label);
    actions.push({ id: `action_${actions.length}`, label, kind, type: type || element.tagName.toLowerCase() });
  }
  return actions;
}

function isFinalApplicationSubmit(document, event) {
  const form = event?.target;
  if (!form || String(form.tagName || '').toLowerCase() !== 'form') return false;
  const root = applicationRoot(document);
  if (root !== document && root !== form) return false;
  if (root === document && !inApplication(document, form)) return false;
  const formActions = [...document.querySelectorAll('button, input[type="submit"], input[type="button"]')]
    .filter((control) => control.form === form && !control.disabled && isVisible(control))
    .map((control) => actionKind(control));
  const hasSingleFinalAction = formActions.filter((kind) => kind === 'submit').length === 1;
  const submitter = event?.submitter;
  if (submitter) {
    return submitter.form === form
      && actionKind(submitter) === 'submit'
      && hasSingleFinalAction;
  }
  return hasSingleFinalAction && !formActions.includes('next');
}

function pauseReasons(document) {
  const reasons = [];
  const visibleText = [...(document.body?.querySelectorAll('*') || [])]
    .filter(isVisible)
    .map((element) => element.textContent || '')
    .join(' ');
  if ([...document.querySelectorAll('input[type="file"]:not([disabled])')].some((element) => isVisible(element) && !(element.files?.length || element.value))) reasons.push('file_upload');
  const captchaElement = [...document.querySelectorAll('[id*="captcha" i], [class*="captcha" i], [id*="recaptcha" i], [class*="recaptcha" i]')].some(isVisible);
  if (captchaElement || /\bcaptcha\b/i.test(visibleText)) reasons.push('captcha');
  const loginPath = /(?:^|\/)(?:login|signin|sign-in)(?:\/|$)/i.test(document.location?.pathname || '');
  const loginForm = [...document.querySelectorAll('form[action]')].some((form) => /login|signin|sign-in/i.test(form.action || form.getAttribute('action') || ''));
  const loginHeading = [...document.querySelectorAll('h1, h2, h3')].some((element) => isVisible(element) && /^(?:sign in|log in|login)$/i.test(element.textContent.trim()));
  if ([...document.querySelectorAll('input[type="password"]:not([disabled])')].some(isVisible) || loginPath || loginForm || loginHeading) reasons.push('login');
  const unresolvedCustomWidget = customWidgetElements(document)
    .some((element) => customWidgetRequired(element) && !customWidgetValue(element));
  const contentEditable = [...document.querySelectorAll('[contenteditable="true"]')].some(isVisible);
  if (contentEditable || unresolvedCustomWidget) reasons.push('unsupported_widget');
  const nextCount = collectActions(document).filter((action) => action.kind === 'next').length;
  const submitCount = collectActions(document).filter((action) => action.kind === 'submit').length;
  if (nextCount > 1 || submitCount > 1) reasons.push('ambiguous_navigation');
  return [...new Set(reasons)];
}

function inspectDocument(document) {
  const actions = collectActions(document);
  return {
    page: extractJobContext(document),
    fields: collectFieldDescriptors(document),
    actions,
    pauseReasons: pauseReasons(document),
  };
}

function validateDocument(document) {
  const requiredEmpty = [];
  const invalid = [];
  for (const field of collectFieldDescriptors(document)) {
    const element = elementForField(document, field.id);
    if (field.required && !field.currentValue) requiredEmpty.push({ fieldId: field.id, label: field.label, type: field.type });
    if (!checkValiditySafely(element) || element?.getAttribute('aria-invalid') === 'true') invalid.push({ fieldId: field.id, label: field.label, type: field.type });
  }
  return { ok: requiredEmpty.length === 0 && invalid.length === 0, requiredEmpty, invalid };
}

function collectAnswerRecords(document) {
  ensureEditTracking(document);
  const fields = collectFieldDescriptors(document);
  const invalidIds = new Set(validateDocument(document).invalid.map((field) => field.fieldId));
  const occurrenceByKey = new Map();
  return fields
    .map((field) => {
      const concept = canonicalConcept(field.label || field.id);
      const baseKey = concept === 'generic_name' ? 'full_name' : /_compensation$/.test(concept) ? slugify(field.label) : concept;
      const occurrence = (occurrenceByKey.get(baseKey) || 0) + 1;
      occurrenceByKey.set(baseKey, occurrence);
      const repeated = occurrence > 1 || /__\d+$/.test(field.id);
      const element = elementForField(document, field.id);
      const provenance = (element?.type === 'radio' ? radioGroup(document, element).some((item) => item.__jobApplicationUserEdited) : element?.__jobApplicationUserEdited)
        || element?.__jobApplicationAutofillValue == null
        ? 'user'
        : 'autofill';
      return {
        key: field.entityType && field.entityId ? `${baseKey}__${slugify(field.entityId)}` : repeated ? `${baseKey}__entry_${occurrence}` : baseKey,
        question: field.label || field.id,
        answer: field.currentValue,
        formOrder: field.formOrder,
        aliases: [field.label, field.id].filter(Boolean),
        type: field.type,
        sensitivity: inferSensitivity(field.label, field.id),
        concept: concept === 'generic_name' ? 'full_name' : concept,
        provenance,
        userEdited: Boolean(element?.type === 'radio' ? radioGroup(document, element).some((item) => item.__jobApplicationUserEdited) : element?.__jobApplicationUserEdited),
        completed: field.labelConfidence !== 'low' && element?.__jobApplicationUserCompleted !== false,
        ...(field.entityId ? { entityId: field.entityId } : {}),
        ...(field.entityType ? { entityType: field.entityType } : {}),
        ...(field.section ? { context: field.section } : {}),
        ...(repeated && !field.entityId ? { entityId: `entry-${occurrence}` } : {}),
      };
    }).filter((record) => record.answer && validateFillValue({ type: record.type }, record.answer).ok
      && !record.aliases.some((alias) => invalidIds.has(alias)));
}

function focusField(document, fieldId) {
  const element = elementForField(document, fieldId);
  if (!element) return false;
  const className = 'job-autofill-focus-highlight';
  for (const highlighted of document.querySelectorAll(`.${className}`)) highlighted.classList.remove(className);
  const targets = new Set([element]);
  for (const label of element.labels || []) targets.add(label);
  if (element.id) {
    for (const label of document.querySelectorAll('label')) {
      if (label.htmlFor === element.id) targets.add(label);
    }
  }
  if (element.type === 'radio' || element.type === 'checkbox') {
    const group = element.closest('fieldset,[role="radiogroup"],[role="group"]');
    if (group) targets.add(group);
  }
  for (const target of targets) target.classList?.add(className);
  const styleId = 'job-autofill-focus-highlight-style';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `.${className}{outline:3px solid #d7ff45!important;outline-offset:4px!important;box-shadow:0 0 0 6px rgba(215,255,69,.28)!important;border-radius:4px!important;}`;
    document.head?.append(style);
  }
  element.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  element.focus?.({ preventScroll: true });
  setTimeout(() => {
    for (const target of targets) target.classList?.remove(className);
  }, 4000);
  return true;
}

function findActionElement(document, actionId) {
  const actions = [...document.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"]')];
  let index = 0;
  for (const element of actions) {
    if (element.disabled || !isVisible(element) || !actionLabel(element) || !inApplication(document, element)) continue;
    const action = collectActions(document).find((candidate) => candidate.id === `action_${index}`);
    if (action?.id === actionId) return { element, action };
    index += 1;
  }
  return null;
}

function clickAction(document, actionId) {
  const found = findActionElement(document, actionId);
  if (!found || found.action.kind !== 'next') return { ok: false, error: 'Navigation action is unavailable or not a validated Next control' };
  found.element.click();
  return { ok: true, action: found.action };
}

function waitForDocumentSettled(document, { quietMs = 150, minWaitMs = 400, timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let changed = started;
    let timer;
    const observer = document.defaultView?.MutationObserver ? new document.defaultView.MutationObserver(() => { changed = Date.now(); }) : null;
    const finish = () => { clearTimeout(timer); observer?.disconnect(); resolve(); };
    const check = () => {
      const now = Date.now();
      if (now - started >= timeoutMs || (now - started >= minWaitMs && now - changed >= quietMs)) return finish();
      timer = setTimeout(check, 25);
    };
    if (document.documentElement) observer?.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    check();
  });
}

// Learning is enabled only by the worker for the selected application frame.
function createLearningSession(document, { capture, send, onFinalSubmit, delayMs = 350 }) {
  let applicationId = null;
  let timer;
  let lastSaved = '';
  let queue = Promise.resolve();
  function flush() {
    clearTimeout(timer);
    if (!applicationId || document.__jobApplicationFilling) return queue;
    const records = capture().filter((record) => record.provenance === 'user');
    if (!records.length) return queue;
    const signature = JSON.stringify(records);
    const id = applicationId;
    queue = queue.catch(() => {}).then(async () => {
      if (signature === lastSaved || applicationId !== id) return;
      const response = await send({ type: 'JOB_APP_LEARN', applicationId: id, records });
      if (!response?.ok) throw new Error(response?.error || 'Learning checkpoint was not saved');
      lastSaved = signature;
    });
    return queue;
  }
  function schedule(event) {
    if (!applicationId || document.__jobApplicationFilling || event.target?.__jobApplicationAutofillDispatch) return;
    clearTimeout(timer);
    timer = setTimeout(() => { flush().catch(() => {}); }, delayMs);
  }
  const checkpoint = (event) => {
    flush().catch(() => {});
    if (event?.type !== 'submit' || !applicationId || document.__jobApplicationFilling || typeof onFinalSubmit !== 'function') return;
    try {
      Promise.resolve(onFinalSubmit({ applicationId, records: capture(), event })).catch(() => {});
    } catch (_) {}
  };
  for (const name of ['input', 'change', 'blur', 'click']) document.addEventListener(name, schedule, true);
  document.addEventListener('submit', checkpoint, true);
  document.addEventListener('visibilitychange', checkpoint, true);
  document.defaultView?.addEventListener('pagehide', checkpoint);
  return {
    activate(id) {
      if (applicationId !== id) lastSaved = '';
      applicationId = id || null;
    },
    flush,
    dispose() {
      applicationId = null;
      clearTimeout(timer);
      for (const name of ['input', 'change', 'blur', 'click']) document.removeEventListener(name, schedule, true);
      document.removeEventListener('submit', checkpoint, true);
      document.removeEventListener('visibilitychange', checkpoint, true);
      document.defaultView?.removeEventListener('pagehide', checkpoint);
    },
  };
}



function notifyNavigation() {
  waitForDocumentSettled(document).then(() => chrome.runtime.sendMessage({ type: 'JOB_APP_NAVIGATED' })).catch(() => {});
}

const CONTENT_VERSION = 'general-reuse-1';
if (!globalThis.__jobApplicationAutofillInstalled) {
  globalThis.__jobApplicationAutofillInstalled = CONTENT_VERSION;
  const learning = createLearningSession(document, {
    capture: () => collectAnswerRecords(document),
    send: (message) => chrome.runtime.sendMessage(message),
    onFinalSubmit: ({ applicationId, records, event }) => {
      if (!isFinalApplicationSubmit(document, event)) return null;
      return chrome.runtime.sendMessage({
        type: 'JOB_APP_FINAL_SUBMISSION',
        applicationId,
        page: inspectDocument(document).page,
        records,
      });
    },
  });
  chrome.runtime.sendMessage({ type: 'JOB_APP_LEARNING_STATUS' }).then((response) => {
    if (response?.applicationId) learning.activate(response.applicationId);
  }).catch(() => {});
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      switch (message?.type) {
        case 'JOB_APP_PING':
          sendResponse({ ok: true, version: CONTENT_VERSION });
          break;
        case 'JOB_APP_INSPECT':
          waitForDocumentSettled(document, { minWaitMs: 150, quietMs: 75 }).then(() => sendResponse({ ok: true, inspection: inspectDocument(document) }))
            .catch((error) => sendResponse({ ok: false, error: error.message }));
          return true;
        case 'JOB_APP_APPLY':
          if (message.applicationId) learning.activate(message.applicationId);
          applyDecisions(document, message.decisions || [])
            .then((result) => sendResponse({ ok: true, result }))
            .catch((error) => sendResponse({ ok: false, error: error.message }));
          return true;
        case 'JOB_APP_CAPTURE':
          sendResponse({ ok: true, records: collectAnswerRecords(document) });
          break;
        case 'JOB_APP_VALIDATE':
          sendResponse({ ok: true, validation: validateDocument(document) });
          break;
        case 'JOB_APP_FOCUS':
          sendResponse({ ok: focusField(document, message.fieldId) });
          break;
        case 'JOB_APP_LOAD_CHOICE_OPTIONS':
          revealChoiceOptions(document, message.fieldId)
            .then((field) => sendResponse({ ok: Boolean(field), field }))
            .catch((error) => sendResponse({ ok: false, error: error.message }));
          return true;
        case 'JOB_APP_CLICK_NEXT':
          learning.flush().then(() => {
            const result = clickAction(document, message.actionId);
            if (result.ok) notifyNavigation();
            sendResponse(result);
          }).catch((error) => sendResponse({ ok: false, error: error.message }));
          return true;
        default:
          return false;
      }
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return false;
  });
}

})();
