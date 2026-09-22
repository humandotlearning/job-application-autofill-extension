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
  phone_number: /^(?:phone|phone number|mobile|mobile number|telephone)$/,
  phone_extension: /^(?:(?:phone|telephone|mobile) )?extension$/,
  phone_country_code: /^(?:country code|country phone code|phone country code|country calling code|calling code)$/,
  phone_device_type: /^(?:phone|telephone|mobile) (?:device )?type$/,
  address_line_1_local: /^(?:address )?line 1 local$|^street local$/,
  address_line_2_local: /^(?:address )?line 2 local$/,
  address_line_3_local: /^(?:address )?line 3 local$/,
  address_line_1: /^(?:address )?line 1$|^street(?: address)?$/,
  address_line_2: /^(?:address )?line 2$/,
  address_line_3: /^(?:address )?line 3$/,
  city_local: /^city local$|^locality local$/,
  city: /^city$|^locality$/,
  postal_code: /^(?:postal|post|zip|pin) code$|^postcode$|^pincode$/,
  state: /^(?:state|state or territory|territory|region)$/,
  github_url: /^(?:(?:link|url) (?:to|for) (?:your |my )?)?github(?: profile)?(?: link| url)?$/,
  linkedin_url: /^(?:(?:link|url) (?:to|for) (?:your |my )?)?linkedin(?: profile)?(?: link| url)?$/,
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
  const cleaned = text.replace(/^(?:(?:what is|please enter|please provide|provide|enter) )?(?:your )?/, '')
    .replace(/\blinked in\b/g, 'linkedin').replace(/\bgit hub\b/g, 'github');
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
  'address line1': ['address_line_1'],
  'address line2': ['address_line_2'],
  'address line3': ['address_line_3'],
  organization: ['current_employer', 'employer', 'company'],
  url: ['website', 'linkedin', 'portfolio', 'github'],
};

const GENERIC_NAME_LABELS = new Set(['name', 'your name', 'applicant name', 'candidate name']);

function isOpaqueIdentifier(value) {
  const text = String(value ?? '').trim();
  const distinctHexCharacters = new Set(text.toLowerCase()).size;
  return (/^[a-f\d]{24,}$/i.test(text) && (/\d/.test(text) || distinctHexCharacters >= 3))
    || /^(?:[a-z][a-z\d_-]*\|)?[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}(?:\[[a-z\d_-]+\])?$/i.test(text);
}

function canonicalConcept(value = '') {
  return conceptForNormalized(normalizeText(value));
}

function recordConceptFor(record) {
  const candidates = [record.concept, record.key, record.question].filter(Boolean).map(canonicalConcept);
  return candidates.find(concept => Object.hasOwn(CONCEPT_REGISTRY, concept)) || canonicalConcept(record.question || record.key);
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
  // A stored fact (including demographics) is not the same thing as a legal
  // declaration.  Only declarations and explicit consent stay manual.
  if (/\b(consent|agree|agreement|certif(?:y|ication)|attest|attestation|privacy|terms|declaration|conflict of interest|criminal)\b/.test(text)) {
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
  const updatedAt = timestamp(record.updatedAt);
  const normalized = {
    key,
    question: question || key.replace(/_/g, ' '),
    answer,
    aliases,
    type: String(record.type || 'text'),
    sensitivity,
    updatedAt,
  };
  for (const key of ['id', 'concept', 'entityId', 'entityType', 'employmentId', 'context', 'provenance', 'confirmedAt', 'confirmationState', 'pendingAnswer', 'reusePolicy', 'reuseScope', 'country', 'validUntil', 'changeReviewedAt']) {
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

function profileUrlCompatible(concept, value) {
  if (!['github_url', 'linkedin_url'].includes(concept)) return true;
  let url;
  try { url = new URL(String(value)); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  const hostname = url.hostname.toLowerCase();
  if (concept === 'github_url') {
    return ['github.com', 'www.github.com'].includes(hostname)
      && /^\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/?$/.test(url.pathname);
  }
  return (hostname === 'linkedin.com' || hostname.endsWith('.linkedin.com'))
    && /^\/(?:in\/[^/]+\/?|pub\/[^/]+(?:\/[^/]+)*\/?)$/i.test(url.pathname);
}

function recordScopeCompatible(field, record) {
  if (record.semantic?.reusePolicy === 'never' || record.reusePolicy === 'never') return false;
  if (record.reuseScope === 'application') return false;
  if (record.suppressedFor?.includes(suggestionTargetKey(field))) return false;
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
  const recordConcept = recordConceptFor(record);
  if ([fieldConcept, recordConcept].some(concept => /^(?:address_line_[123]|city)_local$/.test(concept)) && fieldConcept !== recordConcept) return false;
  const addressConcepts = new Set(['address', 'address_line_1_local', 'address_line_2_local', 'address_line_3_local', 'address_line_1', 'address_line_2', 'address_line_3', 'city_local', 'city', 'postal_code', 'state']);
  if (addressConcepts.has(fieldConcept) && addressConcepts.has(recordConcept)) {
    if (fieldConcept !== recordConcept) return false;
  }
  const profileConcept = [fieldConcept, recordConcept].find((concept) => ['github_url', 'linkedin_url'].includes(concept));
  if (profileConcept && !profileUrlCompatible(profileConcept, record.answer)) return false;
  if (recordConcept === 'github_url'
    && ((normalizeText(field.type) === 'textarea' && fieldConcept !== 'github_url') || /\b(username|repository|repo|project)\b/.test(left))) return false;
  const phoneConcepts = new Set(['phone_number', 'phone_extension', 'phone_country_code', 'phone_device_type']);
  if (phoneConcepts.has(fieldConcept) || phoneConcepts.has(recordConcept)) return fieldConcept === recordConcept;
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
  records = records.filter((record) => !isOpaqueIdentifier(record.answer)
    && !isOpaqueIdentifier(record.question) && !isOpaqueIdentifier(record.key)
    && recordScopeCompatible(field, record) && meaningCompatible(field, record));
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
    const fullName = unambiguous(records.filter((record) => recordConceptFor(record) === 'full_name' && String(record.answer ?? '').trim()));
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
        const concept = recordConceptFor(record);
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
    const recordConcept = recordConceptFor(record);
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
  if (isOpaqueIdentifier(text)) return { ok: false, reason: 'value is an opaque internal identifier' };
  const constraints = field.constraints || {};
  if (Array.isArray(field.options) && field.options.length) {
    const exactOption = field.options.some(option => normalizeText(option) === normalizeText(text));
    const values = field.multiple && !exactOption ? text.split(/\s*[,;]\s*/) : [text];
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

function lowRiskSemanticField(field = {}) {
  if (field.widget || field.multiple || field.entityUnresolved || field.labelConfidence !== 'high'
    || !['text', 'email', 'tel', 'url', 'select', 'select-one', 'radio'].includes(field.type)
    || inferSensitivity(field.label, field.id) !== 'safe') return false;
  const concept = canonicalConcept(field.label);
  return ['generic_name', 'first_name', 'last_name', 'full_name', 'preferred_name', 'email',
    'phone_number', 'phone_country_code', 'phone_device_type', 'address_line_1', 'address_line_2',
    'city', 'postal_code', 'state', 'github_url', 'linkedin_url', 'portfolio_url', 'current_employer',
    'current_city', 'current_location', 'employer', 'company', 'job_title', 'role', 'school',
    'university', 'degree', 'highest_degree', 'field_of_study'].includes(concept);
}

function semanticAutofillQualified(semantic = {}) {
  return semantic.coverageComplete === true && semantic.selectedProbability >= 0.98
    && semantic.confidence >= 0.90 && semantic.sufficiency >= 0.98 && semantic.conflict <= 0.02;
}

function decideDisposition(decision = {}, field = {}) {
  const manual = reason => ({ disposition: 'manual', reason });
  const review = reason => ({ disposition: 'review', reason });
  const sensitivity = inferSensitivity(field.label || field.question, `${field.name || ''} ${field.id || ''}`);
  if (field.labelConfidence === 'low') return manual('Field meaning is unclear');
  if (field.entityUnresolved) return manual('Employment identity is unresolved');
  if (sensitivity === 'legal' || decision.sensitivity === 'legal') return manual('Legal and consent answers require manual entry');
  if (decision.reusePolicy === 'never' || decision.semantic?.reusePolicy === 'never') return manual('Source prohibits reuse');
  if (decision.action === 'ask_user' || decision.value == null || !String(decision.value).trim() || decision.compatible === false || decision.conflicting) return manual('Missing, conflicting, or incompatible evidence');
  if (decision.confirmationState === 'pending') return manual('Saved answer has a pending conflict');
  if (decision.approved === true) return { disposition: 'autofill', reason: 'Explicitly approved answer' };
  if (decision.reusePolicy === 'review_only' || decision.semantic?.reusePolicy === 'review_only') return review('Source requires review on every reuse');
  if (sensitivity !== 'safe' || decision.sensitivity !== 'safe') return review('Sensitive answer requires approval');
  if (normalizeText(field.type) === 'textarea' || String(decision.value).length > 240 || /describe|tell us|why.*(?:join|company|work)|motivat/.test(normalizeText(field.label))) return review('Narrative answer requires approval');
  if (decision.confirmationState !== 'confirmed') return review('Saved answer is not confirmed');
  if (decision.matchKind === 'semantic' && decision.compatible === true && lowRiskSemanticField(field)
    && semanticAutofillQualified(decision.semantic)) return { disposition: 'autofill', reason: 'Validated low-risk JEV match' };
  if (!['exact', 'concept'].includes(decision.matchKind) || decision.confidence !== 'high') return review('Match requires explicit approval');
  return { disposition: 'autofill', reason: 'Unique confirmed compatible short fact' };
}

function shouldReviewDecision(decision = {}, field = {}) {
  return decideDisposition(decision, field).disposition !== 'autofill';
}

function shouldAutofill(record = {}) {
  return decideDisposition({ value: record.answer, sensitivity: record.sensitivity, confirmationState: record.confirmationState, reusePolicy: record.semantic?.reusePolicy || record.reusePolicy, matchKind: 'exact', confidence: 'high' }, { label: record.question, type: record.type }).disposition === 'autofill';
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
    const alternatives = uniqueStrings([...(previous.alternatives || []), ...(next.alternatives || [])])
      .filter((value) => normalizeText(value) !== normalizeText(next.answer));
    merged.set(next.key, {
      ...next,
      aliases: uniqueStrings([
        ...(previous.aliases || []),
        ...(next.aliases || []),
        previous.question,
        next.question,
      ]),
      ...(alternatives.length ? { alternatives } : {}),
      ...(history.length ? { history } : {}),
    });
  }
  return [...merged.values()];
}

function mergeLearnedAnswers(existing = [], incoming = [], now = new Date().toISOString(), { confirm = false } = {}) {
  let result = existing.map(normalizeAnswerRecord);
  for (const raw of incoming) {
    if (raw.provenance !== 'user' || raw.completed === false
      || isOpaqueIdentifier(raw.answer) || isOpaqueIdentifier(raw.question) || isOpaqueIdentifier(raw.key)
      || !validateFillValue({ type: raw.type }, raw.answer).ok) continue;
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
        changeReviewedAt: undefined,
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

// One short-lived index per synchronous inspection. Never cache across a fill/await.
const domSnapshots = new WeakMap();
const EXTENSION_UI = '[data-job-inline-autofill]';

function composedParent(element) {
  return element?.assignedSlot || element?.parentElement || element?.getRootNode?.().host || null;
}

function composedClosest(element, selector) {
  for (let current = element; current; current = composedParent(current)) {
    if (current.matches?.(selector)) return current;
  }
  return null;
}

function composedContains(root, element) {
  for (let current = element; current; current = composedParent(current)) {
    if (current === root || current.getRootNode?.() === root) return true;
  }
  return false;
}

function isExtensionElement(element) {
  return Boolean(composedClosest(element, EXTENSION_UI));
}

function createDomIndex(document) {
  const elements = [], roots = [document], seen = new Set();
  function visit(node) {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (node.nodeType === 1) {
      if (node.matches(EXTENSION_UI)) return;
      elements.push(node);
      if (node.shadowRoot) { roots.push(node.shadowRoot); visit(node.shadowRoot); return; }
      if (node.tagName === 'SLOT') {
        const assigned = node.assignedNodes?.({flatten: true}) || [];
        if (assigned.length) { for (const child of assigned) visit(child); return; }
      }
    }
    for (const child of node.childNodes || []) visit(child);
  }
  visit(document);
  return {elements, roots, queries: new Map(), memo: new Map(), order: new Map(elements.map((el, i) => [el, i]))};
}

function withDomSnapshot(document, callback) {
  if (domSnapshots.has(document)) return callback(domSnapshots.get(document));
  const index = createDomIndex(document);
  domSnapshots.set(document, index);
  try { return callback(index); } finally { domSnapshots.delete(document); }
}

function domMemo(document, key, compute) {
  const index = domSnapshots.get(document);
  if (!index) return compute();
  if (!index.memo.has(key)) index.memo.set(key, compute());
  return index.memo.get(key);
}

function queryAll(root, selector) {
  if (!root) return [];
  const document = root.nodeType === 9 ? root : root.ownerDocument;
  const index = domSnapshots.get(document) || createDomIndex(document);
  if (!index.queries.has(selector)) index.queries.set(selector, index.elements.filter(el => el.matches(selector)));
  return index.queries.get(selector).filter(el => el !== root && (root === document || composedContains(root, el)));
}

function rootElementById(element, id) {
  if (!id) return null;
  // IDs are scoped to their tree. Do not accidentally resolve a sibling component's ID.
  return element.getRootNode?.().getElementById?.(id) || null;
}

function deepActiveElement(document) {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement && !element.matches(EXTENSION_UI)) element = element.shadowRoot.activeElement;
  return element;
}

function eventControl(event) {
  return event.composedPath?.().find(node => node?.nodeType === 1) || event.target;
}

function composedText(element) {
  const seen = new Set();
  function read(node) {
    if (!node || seen.has(node)) return '';
    seen.add(node);
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType === 1 && node.matches('script,style,[hidden],[aria-hidden="true"],' + EXTENSION_UI)) return '';
    const assigned = node.tagName === 'SLOT' ? node.assignedNodes?.({flatten: true}) : null;
    const children = assigned?.length ? assigned : node.shadowRoot?.childNodes || node.childNodes || [];
    return [...children].map(read).join('');
  }
  return read(element).replace(/\s+/g, ' ').trim();
}



const IGNORED_TYPES = new Set(['hidden', 'password', 'file', 'submit', 'button', 'reset', 'image', 'search']);
const SECRET_MARKER = /(?:password|passcode|passwd|pwd|secret|token|csrf|auth[_-]?token)/i;
const CUSTOM_WIDGET_SELECTOR = '[role="combobox"], button[aria-haspopup="listbox"]';
const EMPTY_CUSTOM_WIDGET_VALUE = /^(?:choose|select)\b/i;
const CUSTOM_WIDGET_PROMPT_LABEL = /^(?:choose|select)(?:\s+(?:one|an?\s+option|an?\s+answer|a\s+value))?$/i;
const trackedDocuments = new WeakSet();
const controlHandles = new WeakMap();
const documentHandles = new WeakMap();
const applicationSelections = new WeakMap();
const applicationFieldSelections = new WeakMap();

function documentIdentity(document) {
  controlHandle(document.documentElement);
  return documentHandles.get(document).id;
}

function clearApplicationSelection(document) { applicationSelections.delete(document); applicationFieldSelections.delete(document); }

function selectApplicationField(document, element) {
  if (!element?.isConnected || element.ownerDocument !== document || isExtensionElement(element) || !isSupported(element) || !isVisible(element)) return null;
  clearApplicationSelection(document);
  applicationFieldSelections.set(document, {element, documentId: documentIdentity(document)});
  return {documentId: documentIdentity(document), regionId: null};
}

function isUtilityRegion(region) {
  const label = [region.id, region.getAttribute('role'), region.getAttribute('aria-label'), region.getAttribute('name'),
    ...queryAll(region, 'h1,h2,h3,legend').filter(el => composedClosest(el, 'form,[role="form"]') === region).map(composedText),
    ...queryAll(region, 'button,input[type="submit"]').filter(el => composedClosest(el, 'form,[role="form"]') === region).map(actionLabel)].join(' ');
  return /\b(?:subscribe|newsletter|job.?alerts?|login|sign.?in)\b/i.test(label)
    || region.getAttribute('role') === 'search' || /^search$/i.test(region.id || '');
}

function applicationRegions(document) {
  return domMemo(document, 'regions', () => {
    const controls = queryAll(document, 'input,textarea,select,[role="combobox"]')
      .filter(el => (isSupported(el) || el.matches(CUSTOM_WIDGET_SELECTOR)) && isVisible(el));
    const forms = queryAll(document, 'form,[role="form"]').filter(isVisible);
    const candidates = forms.filter(form => {
      const owned = controls.filter(el => (composedClosest(el, 'form,[role="form"]') || el.form) === form);
      return owned.length && !isUtilityRegion(form);
    });
    const outside = controls.filter(el => !composedClosest(el, 'form,[role="form"],[role="search"],nav'));
    if (outside.length) {
      const mains = [...new Set(outside.map(el => composedClosest(el, 'main,[role="main"]') || document))];
      candidates.push(...mains.filter(root => !candidates.some(form => composedContains(root, form))));
    }
    return {candidates, controls};
  });
}

function selectApplicationRegion(document, element) {
  return withDomSnapshot(document, () => {
    if (!element?.isConnected || element.ownerDocument !== document || isExtensionElement(element) || !isVisible(element)) return null;
    const {candidates, controls} = applicationRegions(document);
    const control = controls.find(el => el === element || composedContains(el, element));
    if (!control) return null;
    const owner = composedClosest(control, 'form,[role="form"]') || control.form;
    const region = candidates.includes(owner) ? owner : candidates.find(root => composedContains(root, control));
    if (!region) return null;
    applicationFieldSelections.delete(document);
    applicationSelections.set(document, {region, documentId: documentIdentity(document)});
    return {documentId: documentIdentity(document), regionId: region === document ? 'document' : controlHandle(region)};
  });
}

function applicationDestination(document) {
  return withDomSnapshot(document, () => {
    const root = applicationRoot(document);
    return {documentId: documentIdentity(document), regionId: root.nodeType === 11 ? null : root === document ? 'document' : controlHandle(root)};
  });
}

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
  const fieldSelection = applicationFieldSelections.get(document);
  if (fieldSelection && fieldSelection.documentId === documentIdentity(document) && fieldSelection.element.isConnected) return document.createDocumentFragment();
  if (fieldSelection) applicationFieldSelections.delete(document);
  const selection = applicationSelections.get(document);
  if (selection && selection.documentId === documentIdentity(document)
    && (selection.region === document || selection.region.isConnected)) return selection.region;
  if (selection) applicationSelections.delete(document);
  const {candidates} = applicationRegions(document);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) return document.createDocumentFragment();
  return document;
}

function inApplication(document, element) {
  const root = applicationRoot(document);
  if (isExtensionElement(element)) return false;
  const selectedField = applicationFieldSelections.get(document)?.element;
  if (selectedField) return element === selectedField;
  if (root !== document) {
    const owner = composedClosest(element, 'form,[role="form"]') || element.form;
    if (owner && owner !== root && applicationRegions(document).candidates.includes(owner)) return false;
    return composedContains(root, element) || element.form === root;
  }
  const owner = composedClosest(element, 'form,[role="form"],[role="search"],nav');
  return !owner || !isUtilityRegion(owner);
}

function ensureEditTracking(document) {
  if (trackedDocuments.has(document)) return;
  const markEdited = (event) => {
    let element = eventControl(event);
    if (isExtensionElement(element)) return;
    if (!element || element.__jobApplicationAutofillDispatch || (document.__jobApplicationFilling && !event.isTrusted)) return;
    if (event.type === 'click') {
      const listbox = composedClosest(composedClosest(element, '[role="option"]'), '[role="listbox"]');
      if (!listbox?.id) return;
      element = customWidgetElements(document).find((widget) => widget.getRootNode() === listbox.getRootNode() && String(widget.getAttribute('aria-controls') || widget.getAttribute('aria-owns') || '').split(/\s+/).includes(listbox.id));
      if (!element) return;
      delete element.__jobApplicationSearchQuery;
    }
    if (event.type === 'blur' && !element.__jobApplicationUserEdited) return;
    if (event.type === 'input' || event.type === 'change') {
      element.__jobApplicationEditRevision = (element.__jobApplicationEditRevision || 0) + 1;
    }
    delete element.__jobApplicationCommittedLabel;
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
  const description = [...queryAll(document, '[itemprop="description"],.job-description,#job-description,[data-testid="job-description"],.posting-page .section-wrapper,.posting-description')]
    .map(node => readable(node)).filter(Boolean).join('\n').slice(0, 16000);
  return {
    title: document.title || '', domain: document.location?.hostname || '',
    role: readable(document.querySelector('[itemprop="title"],h1'), 300),
    company: readable(document.querySelector('[itemprop="hiringOrganization"],.company-name'), 300),
    jobDescription: description,
  };
}

function textFromIds(element, ids = '') {
  return String(ids)
    .split(/\s+/)
    .map((id) => rootElementById(element, id) ? labelText(rootElementById(element, id)) : '')
    .filter(Boolean)
    .join(' ');
}

function cleanLabelString(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  // Phone widgets often append their complete country menu to the accessible
  // name. Keep the question and leave the menu entries in structured options.
  const phoneMenu = /^((?:phone|mobile|telephone)(?:\s+number)?)\s*[*:]?\s*Afghanistan\b.*\+93\s*Albania\b.*\+355/i.exec(text);
  if (phoneMenu) return phoneMenu[1];
  return text.replace(/\s*[*✱]+\s*$/, '').trim();
}

function labelText(label) {
  const excluded = 'script,style,input,textarea,select,button,[role="combobox"],[role="listbox"],[role="option"],[role="menu"],.iti__country-list,.country-list,[hidden],[aria-hidden="true"]';
  function read(node) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return '';
    // Explicit aria-labelledby references may themselves be hidden. Exclude
    // nested widget content without discarding the referenced label root.
    if (node !== label) {
      if (node.matches(excluded)) return '';
      const style = node.ownerDocument.defaultView?.getComputedStyle(node);
      if (style?.display === 'none' || style?.visibility === 'hidden' || style?.contentVisibility === 'hidden') return '';
    }
    const assigned = node.tagName === 'SLOT' ? node.assignedNodes?.({flatten: true}) : null;
    return [...(assigned?.length ? assigned : node.shadowRoot?.childNodes || node.childNodes)].map(read).join('');
  }
  return cleanLabelString(read(label));
}

function nearbyQuestion(element) {
  const controls = 'input:not([type="hidden"]),textarea,select,[role="combobox"],button[aria-haspopup="listbox"]';
  for (let wrapper = composedParent(element), depth = 0; wrapper && depth < 6; wrapper = composedParent(wrapper), depth++) {
    if (wrapper.matches('form,section,main,body')) break;
    const peers = [...queryAll(wrapper, controls)].filter(isVisible);
    if (peers.some(peer => peer !== element && !(['radio', 'checkbox'].includes(element.type) && peer.type === element.type
      && element.name && peer.name === element.name && peer.form === element.form))) break;
    const candidates = [...queryAll(wrapper, '.application-label .text,h3,h4,[role="heading"],legend,label')]
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
  if (checkboxGroup(document, element).length > 1) {
    const container = checkboxContainer(element);
    const heading = container?.querySelector(':scope > legend,.application-label');
    const question = container && (textFromIds(container, container.getAttribute('aria-labelledby'))
      || container.getAttribute('aria-label') || (heading && labelText(heading)));
    const nearby = question || nearbyQuestion(element);
    return {label: nearby || '', labelSource: nearby ? 'group' : 'identity', labelConfidence: nearby ? 'high' : 'low'};
  }
  if (element.type === 'radio') {
    const group = composedClosest(element, 'fieldset,[role="radiogroup"],[role="group"]');
    const explicit = group && (textFromIds(group, group.getAttribute('aria-labelledby')) || group.getAttribute('aria-label') || group.querySelector(':scope > legend')?.textContent?.trim());
    if (explicit) return { label: explicit, labelSource: 'group', labelConfidence: 'high' };
    const peers = radioGroup(document, element);
    const aria = peer => textFromIds(peer, peer.getAttribute('aria-labelledby')) || peer.getAttribute('aria-label') || '';
    const shared = aria(element);
    if (shared && peers.length > 1 && peers.every(peer => aria(peer) === shared)) return { label: shared, labelSource: 'shared-aria', labelConfidence: 'high' };
    const nearby = nearbyQuestion(element);
    return { label: nearby || element.name || element.id || '', labelSource: nearby ? 'nearby-question' : 'identity', labelConfidence: nearby ? 'high' : 'low' };
  }
  const explicit = cleanLabelString(native || element.getAttribute('aria-label') || textFromIds(element, element.getAttribute('aria-labelledby')));
  const nearby = !explicit && nearbyQuestion(element);
  const placeholder = cleanLabelString(element.getAttribute('placeholder'));
  return { label: explicit || nearby || placeholder || element.name || element.id || '',
    labelSource: explicit ? 'explicit' : nearby ? 'nearby-question' : placeholder ? 'placeholder' : 'identity',
    labelConfidence: explicit || nearby || (placeholder && !isOpaqueIdentifier(placeholder)) ? 'high' : 'low' };
}

function labelFor(document, element) {
  if (element.type === 'radio') {
    const legend = composedClosest(element, 'fieldset')?.querySelector('legend')?.textContent?.trim();
    if (legend) return legend;
  }
  const nativeLabel = [...(element.labels || [])]
    .map(labelText)
    .filter(Boolean)
    .join(' ');
  return nativeLabel
    || element.getAttribute('aria-label')
    || textFromIds(element, element.getAttribute('aria-labelledby'))
    || element.getAttribute('placeholder')
    || element.getAttribute('name')
    || element.id
    || '';
}

function isSupported(element) {
  if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) return false;
  if (element.getAttribute('role') === 'combobox' || element.getAttribute('aria-haspopup') === 'listbox') return false;
  if (composedClosest(composedParent(element), CUSTOM_WIDGET_SELECTOR)) return false;
  if (isControlDisabled(element) || element.readOnly || element.getAttribute('aria-readonly') === 'true') return false;
  if (IGNORED_TYPES.has(String(element.type || '').toLowerCase())) return false;
  return !SECRET_MARKER.test(`${element.name || ''} ${element.id || ''} ${element.autocomplete || ''}`);
}

function isControlDisabled(element) {
  return Boolean(element.disabled || element.matches(':disabled') || composedClosest(element, '[aria-disabled="true"],[inert]'));
}

function isVisible(element) {
  return domMemo(element.ownerDocument, element, () => isVisibleUncached(element));
}

function isVisibleUncached(element) {
  for (let current = element; current; current = composedParent(current)) {
    if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false;
    const style = current.getAttribute('style') || '';
    if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style)) return false;
    const computed = current.ownerDocument.defaultView?.getComputedStyle?.(current);
    if (computed && (computed.display === 'none' || computed.visibility === 'hidden' || computed.contentVisibility === 'hidden')) return false;
  }
  return true;
}

function visualRect(element) {
  const rect = element?.getBoundingClientRect?.();
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
  return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
}

function hasNativeFormAction(element) {
  // Use the live native type/form owner: missing or invalid button types submit,
  // and the form attribute can associate a control outside the form subtree.
  const control = composedClosest(element, 'button, input');
  return Boolean(control?.form && ['submit', 'reset', 'image'].includes(control.type));
}

function customWidgetElements(document) {
  return domMemo(document, 'customWidgets', () => [...queryAll(document, CUSTOM_WIDGET_SELECTOR)]
    .filter((element) => !hasNativeFormAction(element))
    .filter((element) => inApplication(document, element) && !isControlDisabled(element) && !element.readOnly && element.getAttribute('aria-readonly') !== 'true')
    .filter((element) => isVisible(element))
    .filter((element) => composedClosest(element, 'form, main, [role="main"]') || hasNearbyFormControl(element))
    .filter((element) => element.getAttribute('aria-label') || element.getAttribute('name')
      || textFromIds(element, element.getAttribute('aria-labelledby')) || associatedLabelText(document, element) || hasNearbyFormControl(element)));
}

function hasNearbyFormControl(element) {
  return [...(element.parentElement?.children || [])]
    .some((sibling) => sibling !== element && ['INPUT', 'TEXTAREA', 'SELECT'].includes(sibling.tagName));
}

function customWidgetValue(element) {
  const liveState = JSON.stringify([element.value || '', element.getAttribute('aria-valuetext') || '', composedText(element)]);
  if (element.__jobApplicationCommittedState !== liveState) delete element.__jobApplicationCommittedLabel;
  const selectedOptions = customWidgetOptions(element.ownerDocument, element)
    .filter((option) => option.getAttribute('aria-selected') === 'true')
    .map(customOptionText)
    .filter(Boolean);
  const typedValue = element.__jobApplicationSearchQuery || (element.getAttribute('aria-expanded') === 'true' && element.__jobApplicationUserEdited) ? '' : element.value;
  const value = String(selectedOptions.length ? selectedOptions.join(', ') : (element.getAttribute('aria-valuetext') || element.__jobApplicationCommittedLabel || typedValue || composedText(element) || ''))
    .replace(/\s+/g, ' ').trim();
  return EMPTY_CUSTOM_WIDGET_VALUE.test(value) || isOpaqueIdentifier(value) ? '' : value;
}

function customWidgetRequired(element) {
  return element.getAttribute('aria-required') === 'true'
    || /\brequired\b/i.test(element.getAttribute('aria-label') || '')
    || Boolean(element.required);
}

function visibleText(element) {
  return cleanLabelString(element?.textContent || '');
}

function associatedLabelText(document, element) {
  const labels = [...(element.labels || [])]
    .map(labelText)
    .filter(Boolean);
  if (labels.length) return labels.join(' ');
  if (!element.id) return '';
  const explicit = [...queryAll(document, 'label')]
    .filter((label) => label.getRootNode() === element.getRootNode() && label.getAttribute('for') === element.id)
    .map(labelText)
    .filter(Boolean);
  return explicit.join(' ');
}

function nearestFieldGroupLabel(element) {
  const group = composedClosest(element, 'fieldset, [role="group"]');
  if (!group) return '';
  for (const current of [group]) {
    const candidates = [...queryAll(current, 'label, legend')]
      .map((candidate) => visibleText(candidate))
      .filter(Boolean);
    const unique = [...new Set(candidates)];
    if (unique.length === 1) return unique[0];
  }
  return '';
}

function fieldContext(element) {
  const group = composedClosest(element, 'fieldset, [role="group"], section, form');
  if (!group) return {};
  const heading = group.querySelector(':scope > legend, :scope > h1, :scope > h2, :scope > h3, :scope > [role="heading"]');
  const section = visibleText(heading);
  const contextText = `${section} ${group.id} ${group.getAttribute('data-automation-id') || ''}`;
  const entityType = /employment|work.?experience|work.?history/i.test(contextText) ? 'employment'
    : /education|school|university/i.test(contextText) ? 'education' : '';
  const entityId = group.getAttribute('data-entity-id') || (entityType || /reference|referee|emergency|supervisor/i.test(contextText) ? group.id || group.getAttribute('name') : '')
    || (entityType ? `${entityType}-${[...queryAll(element.ownerDocument, 'fieldset,[role="group"],section')].indexOf(group) + 1}` : '');
  return {
    ...(section ? { section } : {}),
    ...(entityId ? { entityId } : {}),
    ...(entityType ? { entityType } : {}),
  };
}

function customWidgetLabel(document, element) {
  const associated = associatedLabelText(document, element);
  if (associated) return associated;
  const labelledBy = textFromIds(element, element.getAttribute('aria-labelledby'));
  if (labelledBy) return labelledBy;
  const fieldGroupLabel = nearestFieldGroupLabel(element) || nearbyQuestion(element);
  if (fieldGroupLabel) return fieldGroupLabel;

  const displayed = customWidgetValue(element);
  const ariaLabel = cleanLabelString(element.getAttribute('aria-label') || '');
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
  return String(element.getAttribute('aria-label') || composedText(element) || '').replace(/\s+/g, ' ').trim();
}

function customOptionValue(element) {
  return String(element.getAttribute('data-value') || element.getAttribute('value') || '').trim();
}

function customOptionAliases(option) {
  const label = customOptionText(option);
  // SuccessFactors picklists prefix display labels with an ordinal ("4 - Bachelor's degree").
  const unnumbered = composedClosest(option, '.sf-list-select') ? label.replace(/^\d+\s+[-–—]\s+(?=[A-Za-z])/, '') : label;
  return [label, unnumbered, customOptionValue(option)].filter(Boolean).map(normalizeText);
}

function matchingCustomOptions(options, value) {
  const exact = options.filter((option) => [customOptionText(option), customOptionValue(option)].map(normalizeText).includes(value));
  return exact.length ? exact : options.filter((option) => customOptionAliases(option).includes(value));
}

function customWidgetOptions(document, element) {
  const ids = String(element.getAttribute('aria-controls') || element.getAttribute('aria-owns') || '').split(/\s+/).filter(Boolean);
  const listboxes = ids.length
    ? ids.map((id) => rootElementById(element, id)).filter(Boolean).flatMap((node) => node.matches('[role="listbox"]') ? [node] : [...queryAll(node, '[role="listbox"]')])
    : [...queryAll(document, '[role="listbox"]')];
  const visibleListboxes = listboxes
    .filter((listbox) => isVisible(listbox))
    .filter((listbox) => ids.length || (listboxes.length === 1 && ![...queryAll(document, CUSTOM_WIDGET_SELECTOR)].some((owner) => owner !== element && String(owner.getAttribute('aria-controls') || owner.getAttribute('aria-owns') || '').split(/\s+/).includes(listbox.id))));
  return visibleListboxes
    .flatMap((listbox) => [...queryAll(listbox, '[role="option"]')])
    .filter((option) => isVisible(option) && option.getAttribute('aria-disabled') !== 'true' && !option.disabled);
}

function fieldIdentity(element, index, collection = []) {
  const base = element.id || element.name || `field_${controlHandle(element)}`;
  if (!element.id && !element.name) return base;
  const occurrence = collection.slice(0, index + 1)
    .filter((candidate) => (candidate.id || candidate.name || '') === base).length;
  return occurrence > 1 ? `${base}__${controlHandle(element)}` : base;
}

function formElements(document) {
  return domMemo(document, 'formElements', () => queryAll(document, 'input, textarea, select').filter((element) => isSupported(element) && isVisible(element) && inApplication(document, element)));
}

function uniqueFields(document) {
  const fields = [];
  const seenRadioGroups = new Set();
  for (const [index, element] of formElements(document).entries()) {
    if (element.type === 'checkbox' && checkboxGroup(document, element)[0] !== element) continue;
    if (element.type === 'radio' && element.name) {
      const group = radioGroup(document, element)[0];
      if (seenRadioGroups.has(group)) continue;
      seenRadioGroups.add(group);
    }
    fields.push({ element, index });
  }
  return fields;
}

function fieldOptions(document, element) {
  const checkboxes = checkboxGroup(document, element);
  if (checkboxes.length > 1) return checkboxes.map(optionText).filter(Boolean);
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
    const group = checkboxGroup(document, element);
    if (group.length > 1) return group.filter(candidate => candidate.checked).map(optionText).join(', ');
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

function describeField(document, element, index) {
  const checkboxes = checkboxGroup(document, element);
  const grouped = checkboxes.length > 1;
  const type = grouped || element.tagName === 'SELECT' ? 'select' : element.tagName === 'TEXTAREA' ? 'textarea' : (element.type || 'text');
  const descriptor = {
    id: fieldIdentity(element, index, [...formElements(document), ...customWidgetElements(document)]),
    handle: controlHandle(element),
    multiple: grouped || Boolean(element.multiple),
    ...(grouped ? {widget: 'checkbox-group'} : {}),
    selectedValues: element.tagName === 'SELECT' ? [...element.selectedOptions].filter((option) => option.value).map((option) => option.value) : [],
    structuredOptions: element.tagName === 'SELECT' ? [...element.options].map((option) => ({ label: option.textContent.trim(), value: option.value, selected: option.selected, disabled: option.disabled })) : [],
    ...questionMetadata(document, element),
    helpText: textFromIds(element, element.getAttribute('aria-describedby')).slice(0, 2000),
    nearbyContext: nearbyQuestion(element).slice(0, 1000),
    type,
    autocomplete: element.autocomplete || '',
    placeholder: element.getAttribute('placeholder') || '',
    required: (grouped ? checkboxes : [element]).some(candidate => candidate.required || candidate.getAttribute('aria-required') === 'true'),
    currentValue: fieldValue(document, element),
    options: fieldOptions(document, element),
    constraints: constraintsFor(element),
    ...fieldContext(element),
  };
  if (element.tagName === 'TEXTAREA' || (element.tagName === 'INPUT' && !['checkbox', 'radio'].includes(String(element.type || '').toLowerCase()))) {
    descriptor.rawValue = String(element.value ?? '');
    descriptor.editRevision = element.__jobApplicationEditRevision || 0;
  }
  return descriptor;
}

function collectFieldDescriptors(document) {
  return withDomSnapshot(document, () => collectFieldDescriptorsImpl(document));
}

function collectFieldDescriptorsImpl(document) {
  ensureEditTracking(document);
  const nativeFields = uniqueFields(document).map(({ element, index }) => ({ element, field: describeField(document, element, index) }));
  const customElements = customWidgetElements(document);
  const customFields = customElements
    .filter(element => !nativeFields.some(({element: native}) => native === element))
    .map((element, index) => ({ element, field: {
      id: fieldIdentity(element, formElements(document).length + index, [...formElements(document), ...customElements]),
      handle: controlHandle(element),
      multiple: element.getAttribute('aria-multiselectable') === 'true' || rootElementById(element, element.getAttribute('aria-controls'))?.getAttribute('aria-multiselectable') === 'true',
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
    } }));
  const fields = [...nativeFields, ...customFields]
    .sort(({ element: left }, { element: right }) => {
      return withDomSnapshot(document, index => index.order.get(left) - index.order.get(right));
    })
    .map(({ field }, formOrder) => ({ ...field, formOrder }));
  const groupKey = (field) => `${canonicalConcept(field.label)}:${field.entityId || ''}`;
  const confirmation = field => !field.entityType && canonicalConcept(field.label) === 'email' && /confirm|repeat|re.?enter/i.test(field.label);
  const counts = new Map();
  const occurrences = new Map();
  for (const field of fields) if (!confirmation(field)) counts.set(groupKey(field), (counts.get(groupKey(field)) || 0) + 1);
  return fields.map((field) => {
    if (confirmation(field)) return field;
    const key = groupKey(field);
    const occurrence = (occurrences.get(key) || 0) + 1;
    occurrences.set(key, occurrence);
    return counts.get(key) > 1 ? { ...field, entityId: `${field.entityId || 'entry'}-${occurrence}` } : field;
  });
}

function descriptorForElement(document, element) {
  if (!element || element.ownerDocument !== document || !element.isConnected) return null;
  const handle = controlHandle(checkboxGroup(document, element)[0] || element);
  const described = collectFieldDescriptors(document).find((field) => field.handle === handle);
  if (described) return described;
  // Inline focus can scope one field without granting bulk-fill authority.
  if (deepActiveElement(document) !== element && document.__jobApplicationInlineFocusAnchor !== element) return null;
  const previous = applicationFieldSelections.get(document);
  const previousRegion = applicationSelections.get(document);
  if (!selectApplicationField(document, element)) return null;
  try { return collectFieldDescriptors(document).find(field => field.handle === handle) || null; }
  finally {
    if (previous) applicationFieldSelections.set(document, previous); else applicationFieldSelections.delete(document);
    if (previousRegion) applicationSelections.set(document, previousRegion);
  }
}

function dispatchFormEvents(element) {
  const view = element.ownerDocument.defaultView;
  element.__jobApplicationAutofillDispatch = true;
  try {
    for (const eventName of ['input', 'change', 'blur']) {
      element.dispatchEvent(new view.Event(eventName, { bubbles: true, composed: true }));
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
  if (element?.getAttribute('aria-invalid') === 'true') return false;
  const checkboxes = element && checkboxGroup(element.ownerDocument, element);
  if (checkboxes?.length > 1) return !checkboxes.some(candidate => candidate.getAttribute('aria-invalid') === 'true' || candidate.validity?.customError)
    && (!checkboxes.some(candidate => candidate.required || candidate.getAttribute('aria-required') === 'true') || checkboxes.some(candidate => candidate.checked));
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
  return formElements(document).filter((candidate) => candidate.type === 'radio' && (element.name ? candidate.name === element.name && candidate.form === element.form && candidate.getRootNode() === element.getRootNode() : candidate === element));
}

function checkboxContainer(element) {
  return composedClosest(element, '.application-question,fieldset,[role="group"]');
}

function checkboxGroup(document, element) {
  if (element?.type !== 'checkbox') return [];
  const container = checkboxContainer(element);
  if (!container && !element.name) return [element];
  const peers = formElements(document).filter(candidate => candidate.type === 'checkbox'
    && candidate.form === element.form && candidate.getRootNode() === element.getRootNode()
    && checkboxContainer(candidate) === container);
  const names = new Set(peers.map(candidate => candidate.name).filter(Boolean));
  // Lever includes a nameless Custom option alongside its named pronoun choices.
  // Generic fieldsets may instead contain unrelated consent checkboxes.
  return container?.matches('.application-question') && names.size <= 1 ? peers
    : peers.filter(candidate => element.name ? candidate.name === element.name : candidate === element);
}

function setCheckboxGroup(document, element, answer) {
  const group = checkboxGroup(document, element);
  const exact = group.find(candidate => normalizeText(optionText(candidate)) === normalizeText(answer));
  const requested = exact ? [exact] : String(answer).split(/\s*[,;]\s*/).map(value =>
    group.find(candidate => normalizeText(optionText(candidate)) === normalizeText(value)));
  if (!requested.length || requested.some(candidate => !candidate)) return false;
  for (const candidate of group) {
    candidate.__jobApplicationAutofillValue = String(answer);
    delete candidate.__jobApplicationUserEdited;
    if (candidate.checked !== requested.includes(candidate)) {
      candidate.checked = requested.includes(candidate);
      dispatchFormEvents(candidate);
    }
  }
  return true;
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

function waitForCustomOptions(document, element, answer, timeoutMs = 1500) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      const options = customWidgetOptions(document, element);
      const multiple = element.getAttribute('aria-multiselectable') === 'true'
        || options[0]?.closest('[role="listbox"]')?.getAttribute('aria-multiselectable') === 'true';
      const requested = multiple ? String(answer).split(/\s*[,;]\s*/).map(normalizeText).filter(Boolean) : [normalizeText(answer)];
      if ((options.length && requested.every((value) => matchingCustomOptions(options, value).length)) || Date.now() - startedAt >= timeoutMs) {
        resolve(options);
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

async function setCustomChoiceValue(document, element, answer, deadline = Infinity) {
  element.focus?.();
  if (hasNativeFormAction(element)) {
    return { ok: false, unresolved: true, reason: 'Refusing to activate a native submit/reset control' };
  }
  if (element.getAttribute('aria-expanded') !== 'true') element.click();
  const expected = normalizeText(answer);
  const initialText = normalizeText(element.textContent || '');
  const initialValue = String(element.value || '');
  if (element.tagName === 'INPUT' && element.getAttribute('aria-autocomplete')) {
    element.__jobApplicationSearchQuery = true;
    setTextValue(element, answer);
  }
  const options = await waitForCustomOptions(document, element, answer, Math.max(0, Math.min(1500, deadline - Date.now())));
  if (!options.length) {
    if (element.tagName === 'INPUT') setTextValue(element, '');
    return { ok: false, unresolved: true, reason: 'The custom widget did not reveal any options' };
  }
  const multiple = element.getAttribute('aria-multiselectable') === 'true'
    || options[0]?.closest('[role="listbox"]')?.getAttribute('aria-multiselectable') === 'true';
  const requested = multiple ? String(answer).split(/\s*[,;]\s*/).map(normalizeText).filter(Boolean) : [expected];
  const candidates = requested.map((value) => matchingCustomOptions(options, value));
  const matches = candidates.flat();
  if (candidates.some((options) => options.length !== 1) || new Set(matches).size !== matches.length) {
    return { ok: false, unresolved: true, reason: 'The custom widget does not expose one unique exact option' };
  }
  for (const match of matches) {
    if (Date.now() >= deadline) return { ok: false, unresolved: true, reason: 'Autofill deadline reached' };
    if (match.getAttribute('aria-selected') === 'true') continue;
    // Recheck after awaiting options and after every preceding selection.
    if (hasNativeFormAction(match)) {
      return { ok: false, unresolved: true, reason: 'Refusing to activate a native submit/reset option' };
    }
    match.click();
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  const selectionCommitted = matches.every((option) => option.getAttribute('aria-selected') === 'true')
    || (!element.__jobApplicationSearchQuery && (normalizeText(element.textContent || '') !== initialText
      || String(element.value || '') !== initialValue
      || Boolean(element.getAttribute('aria-valuetext'))));
  if (!selectionCommitted && element.tagName !== 'INPUT') return {ok: false, unresolved: true, reason: 'The custom widget did not accept the selected option'};
  if (selectionCommitted) {
    element.__jobApplicationCommittedLabel = customOptionText(matches[0]);
    element.__jobApplicationCommittedState = JSON.stringify([element.value || '', element.getAttribute('aria-valuetext') || '', composedText(element)]);
  }
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
  const displayedValues = fieldValue(document, element).split(/\s*[,;]\s*/).map(normalizeText).filter(Boolean);
  const expectedValues = requested.slice().sort();
  const displayedMatches = multiple
    ? displayedValues.slice().sort().join('|') === expectedValues.slice().sort().join('|')
    : acceptedSingleValues.includes(displayed) || acceptedSingleValues.includes(backingValue);
  if (!displayedMatches && backingValue !== expected) {
    return { ok: false, unresolved: true, reason: 'The custom widget did not accept the selected option' };
  }
  return { ok: true };
}

async function fillElement(document, element, answer, deadline = Infinity) {
  if (!element) return { ok: false, reason: 'The field control is no longer available' };
  element.__jobApplicationAutofillValue = String(answer);
  delete element.__jobApplicationUserEdited;
  if (customWidgetElements(document).includes(element)) return setCustomChoiceValue(document, element, answer, deadline);
  if (element.tagName === 'SELECT') return { ok: setSelectValue(element, answer) };
  if (element.type === 'radio') return { ok: setRadioGroup(document, element, answer) };
  if (element.type === 'checkbox') return { ok: checkboxGroup(document, element).length > 1
    ? setCheckboxGroup(document, element, answer) : setCheckbox(element, answer) };
  return { ok: setTextValue(element, answer) };
}

function elementsForField(document, fieldId) {
  const nativeElements = formElements(document);
  const nativeMatch = nativeElements.find((element, index) => fieldIdentity(element, index, [...nativeElements, ...customWidgetElements(document)]) === fieldId);
  if (nativeMatch) return [nativeMatch];
  const customFields = customWidgetElements(document);
  const generatedCustomIndex = customFields.findIndex((element, index) => fieldIdentity(element, nativeElements.length + index, [...nativeElements, ...customFields]) === fieldId);
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

const PHONE_CONCEPTS = new Set(['phone_number', 'phone_extension', 'phone_country_code', 'phone_device_type']);

function phoneOptionEntries(field = {}) {
  const structured = Array.isArray(field.structuredOptions) && field.structuredOptions.length
    ? field.structuredOptions
    : (Array.isArray(field.options) ? field.options.map((option) => ({ label: option, value: option })) : []);
  return structured
    .filter((option) => !option.disabled)
    .map((option) => ({ label: String(option.label || '').trim(), value: String(option.value || '').trim() }))
    .filter((option) => option.label || option.value);
}

function phoneChoiceValue(entry = {}) {
  if (entry.label && !isOpaqueIdentifier(entry.label)) return entry.label;
  if (entry.value && !isOpaqueIdentifier(entry.value)) return entry.value;
  return '';
}

function phoneCallingCode(entry = {}) {
  const match = /(?:^|[^\d])\+(\d{1,3})(?!\d)/.exec(`${entry.value} ${entry.label}`);
  return match ? `+${match[1]}` : '';
}

function phoneBlockKey(field = {}) {
  return `${field.entityId || ''}|${field.section ? normalizeText(field.section) : 'phone'}`;
}

function phoneDecision(field, action, value, reason, evidenceKeys = [], transformation = null) {
  return {
    fieldId: field.id,
    action,
    value: action === 'fill' ? value : null,
    evidenceKeys,
    confidence: action === 'fill' ? 'high' : 'low',
    sensitivity: 'safe',
    ...(action === 'fill' && transformation ? { transformation } : {}),
    reason,
  };
}

function phoneBlockDecisions(fields, records, profile = {}) {
  const decisions = new Map();
  const groups = new Map();
  let previousWasPhone = false;
  let previousBaseKey = '';
  let blockIndex = 0;
  for (const field of fields) {
    const concept = canonicalConcept(field.label || field.id);
    if (!PHONE_CONCEPTS.has(concept)) {
      previousWasPhone = false;
      continue;
    }
    const baseKey = phoneBlockKey(field);
    if (!previousWasPhone || previousBaseKey !== baseKey) blockIndex += 1;
    const key = `${baseKey}|${blockIndex}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(field);
    previousWasPhone = true;
    previousBaseKey = baseKey;
  }
  const source = chooseRecord({ label: 'Phone Number', type: 'tel', autocomplete: 'tel' }, records);
  for (const group of groups.values()) {
    const numberField = group.find((field) => canonicalConcept(field.label || field.id) === 'phone_number');
    const countryField = group.find((field) => canonicalConcept(field.label || field.id) === 'phone_country_code');
    const deviceField = group.find((field) => canonicalConcept(field.label || field.id) === 'phone_device_type');
    const sourceAnswer = String(source?.record?.answer || '').trim();
    const sourceDigits = sourceAnswer.replace(/\D/g, '');
    const sourceKey = source?.record?.key ? [source.record.key] : [];
    let splitPrefix = '';
    let splitEntry = null;
    let splitAmbiguous = false;
    if (countryField && /^\s*\+\d/.test(sourceAnswer)) {
      const matches = phoneOptionEntries(countryField)
        .map((entry) => ({ entry, prefix: phoneCallingCode(entry) }))
        .filter(({ prefix }) => prefix && sourceDigits.startsWith(prefix.replace(/\D/g, '')));
      if (matches.length === 1 && phoneChoiceValue(matches[0].entry)) {
        splitPrefix = matches[0].prefix;
        splitEntry = matches[0].entry;
      } else {
        splitAmbiguous = true;
      }
    }
    if (countryField) {
      if (splitEntry && phoneChoiceValue(splitEntry)) decisions.set(countryField.id, phoneDecision(countryField, 'fill', phoneChoiceValue(splitEntry), 'Matched the unique country calling-code option', sourceKey, 'map_option'));
      else if (splitAmbiguous || sourceAnswer) decisions.set(countryField.id, phoneDecision(countryField, 'ask_user', null, splitAmbiguous ? 'Country calling-code options are ambiguous' : 'No unique country calling-code option matches the stored number'));
    }
    if (numberField) {
      if (!sourceAnswer) decisions.set(numberField.id, phoneDecision(numberField, 'ask_user', null, 'No stored phone number is available'));
      else if (countryField && !splitEntry) decisions.set(numberField.id, phoneDecision(numberField, 'ask_user', null, 'Phone number cannot be split safely without a unique country calling code'));
      else {
        const value = splitPrefix ? sourceDigits.slice(splitPrefix.replace(/\D/g, '').length) : sourceAnswer;
        decisions.set(numberField.id, phoneDecision(numberField, 'fill', value, splitPrefix ? 'Split from the stored international number' : 'Copied the stored phone number', sourceKey, 'format_phone'));
      }
    }
    if (deviceField) {
      const desired = String(profile.defaults?.phoneDeviceType || 'Mobile').trim() || 'Mobile';
      const option = phoneOptionEntries(deviceField).find((entry) => normalizeText(entry.label) === normalizeText(desired) || normalizeText(entry.value) === normalizeText(desired));
      if (option && phoneChoiceValue(option)) decisions.set(deviceField.id, phoneDecision(deviceField, 'fill', phoneChoiceValue(option), 'Profile phone device preference', [], 'map_option'));
      else decisions.set(deviceField.id, phoneDecision(deviceField, 'ask_user', null, 'Profile phone device preference is not an available option'));
    }
  }
  return decisions;
}

function isChoiceField(field = {}) {
  return ['select', 'select-one', 'radio', 'checkbox'].includes(normalizeText(field.type));
}

function visibleChoiceLabels(field = {}) {
  const labels = Array.isArray(field.structuredOptions) && field.structuredOptions.length
    ? field.structuredOptions.map((option) => option.label)
    : (Array.isArray(field.options) ? field.options : []);
  return [...new Set(labels.filter((label) => typeof label === 'string' && label.trim() && !isOpaqueIdentifier(label)))];
}

function requiresVisibleChoiceMatch(field = {}) {
  const text = normalizeText(`${field.label || ''} ${field.name || ''} ${field.id || ''}`);
  return /\bhow did you hear\b/.test(text);
}

function exactVisibleChoice(field, answer) {
  return isChoiceField(field) && visibleChoiceLabels(field).some((label) => normalizeText(label) === normalizeText(answer));
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
  const employers = (profile.employment || [])
    .map((entry) => normalizeText(entry.company))
    .filter(Boolean);
  if (!employers.length) return null;
  const employer = employers.find((entry) => company === entry || ` ${text} `.includes(` ${entry} `));
  if (/have you (?:ever |previously )?(?:worked (?:at|for|with)|been employed (?:at|by|with))|former employee|prior employment/.test(text)) {
    return employer ? { value: 'Yes', reason: 'Saved prior employer; confirm relationship' } : null;
  }
  if (/relative|family member|related to/.test(text) && profile.defaultsConfirmation?.relatedToHiringCompany === 'confirmed') {
    return { value: profile.defaults?.relatedToHiringCompany || 'No', reason: 'Profile company-relationship default' };
  }
  if (/know (?:anyone|someone)|friends? (?:or )?contacts?|any contacts? (?:at|in)/.test(text) && profile.defaultsConfirmation?.knownAtHiringCompany === 'confirmed') {
    return { value: profile.defaults?.knownAtHiringCompany || 'No', reason: 'Profile company-contact default' };
  }
  return null;
}

function planDeterministicFill(fields, records, coverMessages = [], profile = {}, page = {}) {
  const phoneDecisions = phoneBlockDecisions(fields, records, profile);
  return fields.map((field) => {
    const phonePlan = phoneDecisions.get(field.id);
    if (phonePlan) return phonePlan;
    const coverDecision = coverMessageDecision(field, coverMessages);
    if (coverDecision) return coverDecision;
    const match = chooseRecord(field, records);
    const usableMatch = match && (!requiresVisibleChoiceMatch(field) || exactVisibleChoice(field, match.record.answer)) ? match : null;
    if (!usableMatch) {
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
      value: usableMatch.record.answer,
      evidenceKeys: [usableMatch.record.key],
      confidence: usableMatch.confidence === 'exact' ? 'high' : usableMatch.confidence,
      sensitivity: usableMatch.record.sensitivity || inferSensitivity(field.label, field.id),
      reason: usableMatch.reason,
      matchKind: usableMatch.score === 1 ? (usableMatch.reason.startsWith('concept:') ? 'concept' : 'exact') : 'fuzzy',
    };
  }).map((decision, index) => {
    const sources = (decision.evidenceKeys || []).map(key => records.find(record => record.key === key)).filter(Boolean);
    const decorated = { ...decision, handle: fields[index].handle,
      confirmationState: sources.length && sources.every(record => record.confirmationState === 'confirmed') ? 'confirmed' : 'unconfirmed',
      reusePolicy: sources.some(record => (record.semantic?.reusePolicy || record.reusePolicy) === 'never') ? 'never' : sources.some(record => (record.semantic?.reusePolicy || record.reusePolicy) === 'review_only') ? 'review_only' : 'allowed',
      matchKind: decision.matchKind || (decision.transformation ? 'derived' : 'exact'),
    };
    return { ...decorated, ...decideDisposition(decorated, fields[index]) };
  });
}

async function applyDecisions(document, decisions = [], { deadline = Infinity, beforeFill = () => true } = {}) {
  const result = { applied: [], kept: [], reviewRequired: [], unresolved: [], failed: [] };
  for (const decision of decisions) {
    try {
    if (Date.now() >= deadline) { result.unresolved.push({ fieldId: decision.fieldId, reason: 'Autofill deadline reached' }); continue; }
    const field = currentField(document, decision.fieldId);
    if (!field || (decision.handle && decision.handle !== field.handle)) {
      result.failed.push({ fieldId: decision.fieldId, reason: 'Field is no longer on the page' });
      continue;
    }
    const element = elementForField(document, decision.fieldId);
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
    if (current && decision.approved !== true) {
      result.kept.push({ fieldId: field.id, value: current });
      addReviewIfNeeded(result, field, decision, current);
      continue;
    }
    const policy = decideDisposition(decision, field);
    if (policy.disposition !== 'autofill') {
      const issue = { ...decision, field, sensitivity: effectiveSensitivity(field, decision), reason: policy.reason, disposition: policy.disposition };
      if (policy.disposition === 'review') result.reviewRequired.push(issue);
      else result.unresolved.push({ ...issue, fieldId: field.id, label: field.label });
      continue;
    }
    // Custom options may be filtered, stale, or loaded only after opening/searching.
    // Validate their exact match against the live popup in setCustomChoiceValue.
    const validation = validateFillValue(field.widget === 'custom' ? { ...field, options: [] } : field, decision.value);
    if (!validation.ok) {
      result.failed.push({ fieldId: field.id, label: field.label, value: decision.value, reason: validation.reason });
      continue;
    }
    const hasExpectedRawValue = Object.hasOwn(decision, 'expectedRawValue');
    const hasExpectedEditRevision = Object.hasOwn(decision, 'expectedEditRevision');
    const rawValueMatches = !hasExpectedRawValue || String(element?.value ?? '') === String(decision.expectedRawValue);
    const editRevisionMatches = !hasExpectedEditRevision || (element?.__jobApplicationEditRevision || 0) === decision.expectedEditRevision;
    if (!beforeFill({field, element, decision}) || !rawValueMatches || !editRevisionMatches) {
      result.failed.push({ fieldId: field.id, reason: 'The field changed before the answer could be applied' });
      continue;
    }
    document.__jobApplicationFilling = true;
    const fillResult = await fillElement(document, element, decision.value, deadline);
    const immediateValue = fieldValue(document, element);
    await waitForDocumentSettled(document, { quietMs: 75, minWaitMs: 120, timeoutMs: Math.max(0, Math.min(400, deadline - Date.now())) });
    const retained = fieldValue(document, element);
    const expected = field.type === 'checkbox' ? (/^(yes|true|checked)$/i.test(String(decision.value)) ? 'Yes' : 'No') : String(decision.value).trim();
    const valuesEqual = (left, right) => field.multiple
      ? left.split(/\s*[,;]\s*/).sort().join('|') === right.split(/\s*[,;]\s*/).sort().join('|')
      : left === right;
    if (fillResult?.ok && (!valuesEqual(retained, field.widget === 'custom' ? immediateValue : expected) || !currentField(document, field.id) || currentField(document, field.id).handle !== field.handle)) {
      result.failed.push({ fieldId: field.id, reason: 'The control did not retain the exact approved value after settling' });
      continue;
    }
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
  return String(element.getAttribute('aria-label') || composedText(element) || element.value || '').replace(/\s+/g, ' ').trim();
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
  const candidates = [...queryAll(document, 'button, input[type="submit"], input[type="button"], a, [role="button"]')];
  for (const [index, element] of candidates.entries()) {
    if (isControlDisabled(element) || !isVisible(element) || !inApplication(document, element)) continue;
    const label = actionLabel(element);
    if (!label) continue;
    const type = String(element.type || '').toLowerCase();
    const kind = actionKind(element, label);
    actions.push({ id: `action_${actions.length}`, handle: controlHandle(element), label, kind, type: type || element.tagName.toLowerCase() });
  }
  return actions;
}

function isFinalApplicationSubmit(document, event) {
  const form = event?.target;
  if (!form || String(form.tagName || '').toLowerCase() !== 'form') return false;
  const root = applicationRoot(document);
  if (root !== document && root !== form) return false;
  if (root === document && !inApplication(document, form)) return false;
  const formActions = [...queryAll(document, 'button, input[type="submit"], input[type="button"]')]
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
  const visibleText = composedText(document.body);
  if ([...queryAll(document, 'input[type="file"]:not([disabled])')].some((element) => isVisible(element) && !(element.files?.length || element.value))) reasons.push('file_upload');
  const captchaElement = [...queryAll(document, '[id*="captcha" i], [class*="captcha" i], [id*="recaptcha" i], [class*="recaptcha" i]')].some(isVisible);
  if (captchaElement || /\bcaptcha\b/i.test(visibleText)) reasons.push('captcha');
  const loginPath = /(?:^|\/)(?:login|signin|sign-in)(?:\/|$)/i.test(document.location?.pathname || '');
  const loginForm = [...queryAll(document, 'form[action]')].some((form) => /login|signin|sign-in/i.test(form.action || form.getAttribute('action') || ''));
  const loginHeading = [...queryAll(document, 'h1, h2, h3')].some((element) => isVisible(element) && /^(?:sign in|log in|login)$/i.test(element.textContent.trim()));
  if ([...queryAll(document, 'input[type="password"]:not([disabled])')].some(isVisible) || loginPath || loginForm || loginHeading) reasons.push('login');
  const unresolvedCustomWidget = customWidgetElements(document)
    .some((element) => customWidgetRequired(element) && !customWidgetValue(element));
  const contentEditable = [...queryAll(document, '[contenteditable="true"]')].some(isVisible);
  if (contentEditable || unresolvedCustomWidget) reasons.push('unsupported_widget');
  const nextCount = collectActions(document).filter((action) => action.kind === 'next').length;
  const submitCount = collectActions(document).filter((action) => action.kind === 'submit').length;
  if (nextCount > 1 || submitCount > 1) reasons.push('ambiguous_navigation');
  return [...new Set(reasons)];
}

function inspectDocument(document) {
  const started = Date.now();
  const inspection = withDomSnapshot(document, () => inspectDocumentImpl(document));
  inspection.discovery.elapsedMs = Date.now() - started;
  return inspection;
}

function inspectDocumentImpl(document) {
  const started = Date.now();
  const actions = collectActions(document);
  const fields = collectFieldDescriptors(document);
  const destination = applicationDestination(document);
  const root = applicationRoot(document);
  const dialog = composedClosest(root, 'dialog,[role="dialog"]');
  // Portal dialogs often put the application heading outside the form.
  // Restrict this hint to the selected region and its dialog, not the whole page.
  const applicationLabel = [...new Set([root, dialog].filter(node => node?.nodeType === 1))]
    .filter(isVisible)
    .flatMap(node => [node.getAttribute('aria-label'), textFromIds(node, node.getAttribute('aria-labelledby')),
      ...queryAll(node, 'h1,h2,h3,legend').filter(isVisible).map(labelText)])
    .filter(Boolean).join(' ').slice(0, 1000);
  const {candidates, controls} = applicationRegions(document);
  const view = document.defaultView;
  const regions = candidates.map(region => ({
    regionId: region === document ? 'document' : controlHandle(region),
    rect: visualRect(region === document ? document.documentElement : region),
  })).filter(region => region.rect);
  const redactions = queryAll(document, 'input,textarea,select,[contenteditable="true"],iframe')
    .filter(isVisible).map(visualRect).filter(Boolean);
  return {
    page: extractJobContext(document),
    applicationLabel,
    fields,
    actions,
    pauseReasons: pauseReasons(document),
    destination,
    visualContext: {
      viewport: {width: Number(view?.innerWidth) || 0, height: Number(view?.innerHeight) || 0},
      regions,
      redactions,
    },
    discovery: {code: !destination.regionId ? 'ambiguous_form' : fields.length ? 'ready' : 'no_supported_controls',
      regionCount: candidates.length, controlCount: controls.length,
      shadowRootCount: withDomSnapshot(document, index => index.roots.length - 1), elapsedMs: Date.now() - started},
  };
}

function validateDocument(document) {
  return withDomSnapshot(document, () => validateDocumentImpl(document));
}

function validateDocumentImpl(document) {
  const requiredEmpty = [];
  const invalid = [];
  for (const field of collectFieldDescriptors(document)) {
    const element = elementForField(document, field.id);
    if (field.required && !field.currentValue) requiredEmpty.push({ fieldId: field.id, label: field.label, type: field.type });
    if (!checkValiditySafely(element) || element?.getAttribute('aria-invalid') === 'true') invalid.push({ fieldId: field.id, label: field.label, type: field.type });
  }
  return { ok: requiredEmpty.length === 0 && invalid.length === 0, requiredEmpty, invalid };
}

function collectAnswerRecords(document, { finalize = false } = {}) {
  return withDomSnapshot(document, () => collectAnswerRecordsImpl(document, finalize));
}

function collectAnswerRecordsImpl(document, finalize) {
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
      const userEdited = (element?.type === 'radio' ? radioGroup(document, element)
        : element?.type === 'checkbox' ? checkboxGroup(document, element) : [element]).some(item => item?.__jobApplicationUserEdited);
      const provenance = userEdited
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
        userEdited,
        completed: field.labelConfidence !== 'low' && (finalize || element?.__jobApplicationUserCompleted !== false),
        ...(field.entityId ? { entityId: field.entityId } : {}),
        ...(field.entityType ? { entityType: field.entityType } : {}),
        ...(field.section ? { context: field.section } : {}),
        ...(repeated && !field.entityId ? { entityId: `entry-${occurrence}` } : {}),
      };
    }).filter((record) => record.answer && validateFillValue({ type: record.type }, record.answer).ok
      && !record.aliases.some((alias) => invalidIds.has(alias)));
}

function focusField(document, fieldId, expectedHandle) {
  const element = elementForField(document, fieldId);
  if (!element || (expectedHandle !== undefined && controlHandle(element) !== expectedHandle)) return false;
  const className = 'job-autofill-focus-highlight';
  for (const highlighted of queryAll(document, `.${className}`)) highlighted.classList.remove(className);
  const targets = new Set([element]);
  for (const label of element.labels || []) targets.add(label);
  if (element.id) {
    for (const label of queryAll(document, 'label')) {
      if (label.getRootNode() === element.getRootNode() && label.htmlFor === element.id) targets.add(label);
    }
  }
  if (element.type === 'radio' || element.type === 'checkbox') {
    const group = composedClosest(element, 'fieldset,[role="radiogroup"],[role="group"]');
    if (group) targets.add(group);
  }
  for (const target of targets) target.classList?.add(className);
  const styleId = 'job-autofill-focus-highlight-style';
  const styleRoot = element.getRootNode();
  if (!styleRoot.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `.${className}{outline:3px solid #d7ff45!important;outline-offset:4px!important;box-shadow:0 0 0 6px rgba(215,255,69,.28)!important;border-radius:4px!important;}`;
    (styleRoot === document ? document.head : styleRoot)?.append(style);
  }
  element.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  element.focus?.({ preventScroll: true });
  setTimeout(() => {
    for (const target of targets) target.classList?.remove(className);
  }, 4000);
  return true;
}

function findActionElement(document, actionId) {
  const actions = [...queryAll(document, 'button, input[type="submit"], input[type="button"], a, [role="button"]')];
  let index = 0;
  for (const element of actions) {
    if (isControlDisabled(element) || !isVisible(element) || !actionLabel(element) || !inApplication(document, element)) continue;
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
    const roots = new Set();
    const changedAt = () => { changed = Date.now(); };
    const observer = document.defaultView?.MutationObserver ? new document.defaultView.MutationObserver(records => {
      if (records.some(record => !isExtensionElement(record.target))) changedAt();
    }) : null;
    const refreshRoots = () => {
      for (const root of createDomIndex(document).roots) if (!roots.has(root)) {
        roots.add(root);
        observer?.observe(root === document ? document.documentElement : root, {childList: true, subtree: true, attributes: true, characterData: true});
        root.addEventListener('slotchange', changedAt);
        changedAt();
      }
    };
    const finish = (timedOut) => {
      clearTimeout(timer); observer?.disconnect();
      for (const root of roots) root.removeEventListener('slotchange', changedAt);
      resolve({timedOut});
    };
    let lastScan = 0;
    const check = () => {
      const now = Date.now();
      if (now - started >= timeoutMs) return finish(true);
      if (now - lastScan >= 100) { refreshRoots(); lastScan = Date.now(); }
      if (now - started >= minWaitMs && now - changed >= quietMs) return finish(false);
      timer = setTimeout(check, 25);
    };
    check();
  });
}


// Learning is enabled only by the worker for the selected application frame.
function createLearningSession(document, { capture, send, onFinalSubmit, onRevalidate, validationDelayMs = 500, delayMs = 350 }) {
  let applicationId = null;
  let timer;
  let validationTimer;
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
    if (isExtensionElement(eventControl(event)) || !applicationId || document.__jobApplicationFilling || eventControl(event)?.__jobApplicationAutofillDispatch) return;
    if (typeof onRevalidate === 'function' && eventControl(event)?.closest?.('input,textarea,select,[role="combobox"],[role="option"],button[aria-haspopup="listbox"]')) {
      clearTimeout(validationTimer);
      const id=applicationId;
      validationTimer=setTimeout(()=>{if(applicationId===id && !document.__jobApplicationFilling) Promise.resolve(onRevalidate({applicationId:id})).catch(()=>{});},validationDelayMs);
    }
    clearTimeout(timer);
    timer = setTimeout(() => { flush().catch(() => {}); }, delayMs);
  }
  const checkpoint = (event) => {
    flush().catch(() => {});
    if (event?.type !== 'submit' || !applicationId || document.__jobApplicationFilling || typeof onFinalSubmit !== 'function') return;
    try {
      Promise.resolve(onFinalSubmit({ applicationId, records: capture({ finalize: true }), event })).catch(() => {});
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
      clearTimeout(validationTimer);
      for (const name of ['input', 'change', 'blur', 'click']) document.removeEventListener(name, schedule, true);
      document.removeEventListener('submit', checkpoint, true);
      document.removeEventListener('visibilitychange', checkpoint, true);
      document.defaultView?.removeEventListener('pagehide', checkpoint);
    },
  };
}


function createInlineAutofill(document, {send, describe}) {
  const view = document.defaultView;
  let host, shadow, dialog, question, searchInput, list, preview, status, use, generate, edit, findSaved, hint, retrySearch;
  let target = null, snapshot = null, sessionId = null, requestId = null;
  let answers = [], index = -1, epoch = 0, acceptance = null;
  let loading = false, retry = false, semanticSearching = false, semanticRetry = false, composing = false, disposed = false, restoringFocus = false;
  let searchTimer = null;
  let searchVersion = 0, searchPending = null, searchReady = false, searching = false;
  let positionFrame = null, mutationObserver = null, resizeObserver = null;
  const listeners = [];
  const requestFrame = callback => view.requestAnimationFrame ? view.requestAnimationFrame(callback) : view.setTimeout(callback, 0);
  const cancelFrame = id => view.cancelAnimationFrame ? view.cancelAnimationFrame(id) : view.clearTimeout(id);
  const uniqueId = () => view.crypto.randomUUID();
  const message = payload => { try { return Promise.resolve(send(payload)); } catch (error) { return Promise.reject(error); } };

  function eligible(element) {
    if (!element?.isConnected || element.ownerDocument !== document || isExtensionElement(element)
      || !((element.tagName === 'INPUT' && ['text', 'email', 'tel', 'url'].includes(element.type)) || element.tagName === 'TEXTAREA')) return null;
    const field = describe(document, element);
    return field && !field.widget && !field.multiple && ['text', 'textarea', 'email', 'tel', 'url'].includes(field.type) ? field : null;
  }
  function fingerprint(field) {
    if (!field) return null;
    return JSON.stringify([field.id, field.handle, field.rawValue, field.editRevision, field.label, field.type,
      field.options || [], field.constraints || {}, Boolean(field.multiple), field.widget || null]);
  }
  function activeField() {
    if (deepActiveElement(document) === host && !host.hidden && eligible(target)) return target;
    return eligible(deepActiveElement(document)) ? deepActiveElement(document) : null;
  }
  function isCurrent(version, element, expected) {
    const focused = deepActiveElement(document);
    return !disposed && epoch === version && target === element
      && (focused === element || focused === host && !host.hidden)
      && fingerprint(eligible(element)) === expected;
  }
  function listen(node, type, handler, options) {
    node?.addEventListener(type, handler, options);
    if (node) listeners.push(() => node.removeEventListener(type, handler, options));
  }
  function node(tag, text, attributes = {}) {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    return element;
  }
  function button(text, action) {
    const element = node('button', text, {type: 'button', tabindex: '-1'});
    element.addEventListener('click', action);
    return element;
  }
  function mount() {
    if (host) return;
    host = node('div', null, {'data-job-inline-autofill': ''});
    host.hidden = true;
    // A sibling of body also stays outside malformed pages whose body is a form.
    document.documentElement.append(host);
    shadow = host.attachShadow({mode: 'open'});
    shadow.append(node('style', `
      :host { all: initial; position: fixed; z-index: 2147483647; color-scheme: light; }
      :host([hidden]) { display: none !important; }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      [role=dialog] { display: flex; flex-direction: column; max-height: inherit; overflow: hidden; padding: 12px; border: 1px solid #cbd5e1;
        border-radius: 10px; background: #fff; color: #17212b; box-shadow: 0 10px 30px #17212b30;
        font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; }
      p { margin: 0 0 7px; white-space: pre-wrap; overflow-wrap: anywhere; }
      [role=option] { padding: 9px 10px; margin: 5px 0; border: 1px solid #d7dfe8; border-radius: 7px; background: #fff; cursor: pointer; }
      [role=option]:hover { background: #f5f8fc; }
      [aria-selected=true] { border-color: #2563eb; background: #eff6ff; box-shadow: inset 3px 0 #2563eb; }
      [data-preview] { white-space: pre-wrap; overflow-wrap: anywhere; margin: 9px 0; padding: 9px 10px; border-radius: 7px; background: #f5f8fc; }
      button { padding: 8px 10px; margin: 5px 5px 0 0; border: 1px solid #bdcad8; border-radius: 7px;
        color: #17212b; background: #fff; font: inherit; cursor: pointer; }
      button:hover:not(:disabled) { background: #f5f8fc; }
      [data-primary]:not(:disabled) { color: #fff; background: #1d4ed8; border-color: #1d4ed8; }
      [data-primary]:hover:not(:disabled) { background: #1e40af; }
      button:disabled { color: #64748b; background: #f5f8fc; cursor: default; }
      :focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
      [role=status] { flex-shrink: 0; color: #334155; padding: 7px 0; overflow-wrap: anywhere; }
      [role=status][data-state=error] { color: #9f1d1d; background: #fff1f2; border: 1px solid #fecdd3; border-radius: 7px; padding: 8px 10px; margin-bottom: 7px; }
      small { display: block; color: #475569; margin-top: 8px; font-size: 12px; }
      [data-question] { flex-shrink: 0; max-height: 76px; overflow: auto; margin-bottom: 8px; font-weight: 700; }
      [data-results] { min-height: 0; overflow-y: auto; }
      [data-search] { width: 100%; margin: 0; padding: 9px 10px; border: 1px solid #bdcad8; border-radius: 7px;
        flex-shrink: 0; color: #17212b; background: #fff; font: inherit; }
      [data-secondary] { margin-top: 4px; }
    `));
    dialog = node('section', null, {role: 'dialog', 'aria-label': 'Application answer suggestions'});
    question = node('p', null, {'data-question': ''});
    searchInput = node('input', null, {type: 'search', maxlength: '200', 'data-search': '', 'aria-label': 'Search previous answers', placeholder: 'Search previous answers'});
    searchInput.addEventListener('input', scheduleSearch);
    list = node('div', null, {role: 'listbox', 'aria-label': 'Saved answers', tabindex: '-1'});
    preview = node('div', null, {'data-preview': ''});
    use = button('Use and save reviewed answer', accept);
    use.setAttribute('data-primary', '');
    generate = button('Generate answer', generateAnswer);
    edit = button('Edit and use', editInPanel);
    findSaved = button('Find saved answer', findSavedAnswer);
    retrySearch = button('Retry search', scheduleSearch);
    status = node('div', '', {role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true'});
    hint = node('small', 'Arrow keys choose an answer; Tab uses the selection. Alt+ArrowDown enters controls. Escape closes.');
    const secondary = node('div', null, {'data-secondary': ''});
    secondary.append(findSaved, generate, edit);
    const results = node('div', null, {'data-results': ''});
    results.append(list, preview, secondary, hint);
    dialog.append(question, searchInput, status, retrySearch, results, use);
    shadow.append(dialog);
  }
  function controlsMode(enabled) {
    for (const element of shadow.querySelectorAll('button, input, [role="listbox"]')) element.tabIndex = enabled ? 0 : -1;
  }
  function setStatus(text, state = 'info') {
    if (/Extension context invalidated/i.test(text)) {
      text = 'The extension was reloaded or disconnected. Keep this form open to preserve unsaved entries, then open the application in a new tab. If your progress is saved, you can refresh this page instead.';
      retrySearch.hidden = true;
      searchInput.disabled = generate.disabled = edit.disabled = use.disabled = true;
    }
    status.textContent = /^Inline destination changed/.test(text)
      ? 'This field changed. Click it again to load suggestions.' : text;
    status.dataset.state = state;
    schedulePosition();
  }
  function provenance(answer) {
    return answer.kind === 'generated' ? `Draft · Evidence: ${(answer.evidenceKeys || []).join(', ') || 'No candidate facts cited'}`
      : `Source: ${answer.sourceQuestion || 'Reviewed answer'} · Saved answer`;
  }
  function render() {
    const kept = snapshot?.rawValue !== '';
    question.hidden = searchInput.hidden = list.hidden = preview.hidden = findSaved.hidden = generate.hidden = edit.hidden = hint.hidden = kept;
    question.textContent = snapshot?.label || 'Application question';
    searchInput.disabled = loading && Boolean(sessionId) && !searching;
    retrySearch.hidden = !retry || !sessionId || kept;
    list.replaceChildren();
    list.removeAttribute('aria-activedescendant');
    answers.forEach((answer, answerIndex) => {
      const option = node('div', null, {role: 'option', id: `inline-answer-${answerIndex}`, 'aria-selected': String(index === answerIndex)});
      const text = String(answer.answer ?? '');
      option.append(node('p', answer.sourceQuestion || 'Generated answer'),
        node('p', answer.kind === 'semantic' || text.length <= 160 ? text : `${text.slice(0, 160)}…`));
      if (answer.kind === 'generated') option.append(node('small', provenance(answer)));
      option.addEventListener('click', () => select(answerIndex));
      list.append(option);
    });
    updateSelection();
    generate.disabled = loading || !sessionId || snapshot?.rawValue !== '';
    edit.disabled = loading || !sessionId;
    findSaved.disabled = loading || semanticSearching || !sessionId || snapshot?.rawValue !== '';
    findSaved.textContent = semanticSearching ? 'Searching saved answers…' : semanticRetry ? 'Try saved-answer search again' : 'Find saved answer';
    schedulePosition();
  }
  function updateSelection() {
    [...list.children].forEach((option, optionIndex) => option.setAttribute('aria-selected', String(index === optionIndex)));
    const answer = answers[index];
    preview.hidden = !answer;
    preview.textContent = answer ? `${answer.answer}\n${provenance(answer)}\n${answer.requiresApproval === false ? 'Review this draft before use.' : 'Using this answer also saves it as a reviewed answer.'}` : '';
    if (answer) list.setAttribute('aria-activedescendant', `inline-answer-${index}`);
    else list.removeAttribute('aria-activedescendant');
    use.textContent = answer?.requiresApproval === false ? 'Use draft' : answer?.kind === 'semantic' ? 'Use answer' : 'Use and save reviewed answer';
    use.disabled = loading || !answer;
    use.hidden = !answer;
    schedulePosition();
  }
  function select(next) {
    if (loading || !answers.length || !isCurrent(epoch, target, fingerprint(snapshot))) return;
    index = (next + answers.length) % answers.length;
    updateSelection();
    setStatus(`Answer ${index + 1} of ${answers.length}. Review the full answer, then choose Use.`);
  }
  function cancelSession(id = sessionId, request = requestId) {
    if (id && request) message({type: 'JOB_INLINE_CANCEL', sessionId: id, requestId: request}).catch(() => {});
  }
  function stopObserving() {
    mutationObserver?.disconnect(); resizeObserver?.disconnect();
    mutationObserver = resizeObserver = null;
    if (positionFrame !== null) { cancelFrame(positionFrame); positionFrame = null; }
  }
  function dismiss({retainSession = false, returnFocus = false} = {}) {
    const previous = target;
    const popupFocused = host && deepActiveElement(document) === host;
    acceptance = null; epoch++;
    delete document.__jobApplicationInlineFocusAnchor;
    if (!retainSession) cancelSession();
    sessionId = requestId = null;
    if (searchTimer !== null) { view.clearTimeout(searchTimer); searchTimer = null; }
    if (searchInput) searchInput.value = '';
    searchVersion++; searchPending = null; searchReady = searching = false;
    target = snapshot = null; answers = []; index = -1; loading = false; retry = false; semanticSearching = semanticRetry = false;
    stopObserving();
    if (host) { host.hidden = true; controlsMode(false); }
    if ((returnFocus || popupFocused) && previous?.isConnected) {
      restoringFocus = true; previous.focus({preventScroll: true}); restoringFocus = false;
    }
  }

  function scheduleSearch() {
    if (!searchInput || searchInput.disabled || !target || snapshot?.rawValue !== '') return;
    // Revoke displayed choices immediately, including during the debounce.
    searchVersion++; searchReady = false; searching = loading = true;
    answers = []; index = -1; retry = false;
    if (searchTimer !== null) view.clearTimeout(searchTimer);
    render(); setStatus('Searching previous answers…');
    if (composing || !sessionId) return;
    searchTimer = view.setTimeout(() => {
      searchTimer = null; searchReady = true; runSearch();
    }, 200);
  }
  function runSearch() {
    // A session's candidate registry is mutable; serialize requests so the
    // latest displayed IDs always belong to its latest worker revision.
    if (!searchReady || searchPending || !sessionId || composing) return;
    searchReady = false;
    const version = epoch, queryVersion = searchVersion, element = target;
    const expected = fingerprint(snapshot), session = sessionId, query = searchInput.value.trim();
    const pending = {}; searchPending = pending;
    requestId = uniqueId(); const request = requestId;
    const current = () => searchVersion === queryVersion && isCurrent(version, element, expected);
    message({type: 'JOB_INLINE_SEARCH', sessionId: session, fieldId: snapshot.id, handle: snapshot.handle, requestId: request, query}).then(response => {
      if (!current()) return;
      if (!response?.ok) throw new Error(response?.error || 'Saved-answer search is unavailable.');
      if (response.sessionId !== session || response.requestId !== request) throw new Error('Search changed. Retry search.');
      answers = (response.candidates || []).slice(0, 20); searching = loading = retry = false; render();
      setStatus(answers.length ? `Found ${answers.length} saved answer${answers.length === 1 ? '' : 's'}. Choose one to review.` : 'No saved answers found.');
    }).catch(error => {
      if (!current()) return;
      searching = loading = false; retry = true; render(); setStatus(error.message, 'error');
    }).finally(() => {
      if (searchPending !== pending) return;
      searchPending = null; runSearch();
    });
  }
  function findSavedAnswer() {
    if(loading||semanticSearching||!sessionId||!isCurrent(epoch,target,fingerprint(snapshot))||snapshot.rawValue!=='')return;
    semanticSearching=true; render(); setStatus('Searching saved answers…');
    const version=epoch,element=target,expected=fingerprint(snapshot),session=sessionId;
    requestId=uniqueId(); const request=requestId;
    const selectedId=answers[index]?.candidateId;
    message({type:'JOB_INLINE_SEMANTIC_SEARCH',sessionId:session,fieldId:snapshot.id,handle:snapshot.handle,
      requestId:request,retry:semanticRetry}).then(response=>{
      if(!isCurrent(version,element,expected))return;
      if(!response?.ok)throw new Error(response?.error||'Couldn’t search saved answers—try again.');
      if(response.sessionId!==session||response.requestId!==request)throw new Error('Saved-answer search changed. Try again.');
      if(response.semanticStatus==='matched') {
        answers=(response.candidates||[]).slice(0,20);
        index=selectedId?answers.findIndex(answer=>answer.candidateId===selectedId):-1;
        semanticRetry=false; setStatus('Saved answer found. Review the original question and full answer.');
      } else if(response.semanticStatus==='none'||response.semanticStatus==='skipped') {
        semanticRetry=false; setStatus('No clear match. You can search by keyword or generate an answer.');
      } else {
        semanticRetry=true; setStatus('Couldn’t search saved answers—try again.','error');
      }
    }).catch(()=>{if(isCurrent(version,element,expected)){semanticRetry=true;setStatus('Couldn’t search saved answers—try again.','error');}})
      .finally(()=>{if(isCurrent(version,element,expected)){semanticSearching=false;render();}});
  }
  function observe() {
    stopObserving();
    mutationObserver = new view.MutationObserver(() => {
      if (!eligible(target) || !host.isConnected) dismiss();
      else schedulePosition();
    });
    // Observe only the open anchor and its ancestor chain, not every page subtree.
    mutationObserver.observe(target, {attributes: true});
    for (let ancestor = composedParent(target); ancestor; ancestor = composedParent(ancestor)) mutationObserver.observe(ancestor, {childList: true});
    if (view.ResizeObserver) { resizeObserver = new view.ResizeObserver(schedulePosition); resizeObserver.observe(target); }
    schedulePosition();
  }
  function schedulePosition() {
    if (!target || !host || host.hidden || positionFrame !== null) return;
    positionFrame = requestFrame(() => { positionFrame = null; position(); });
  }
  function position() {
    if (!target?.isConnected || !host?.isConnected) { dismiss(); return; }
    const rect = target.getBoundingClientRect();
    const viewport = view.visualViewport;
    const leftEdge = viewport?.offsetLeft || 0, topEdge = viewport?.offsetTop || 0;
    const width = viewport?.width || view.innerWidth, height = viewport?.height || view.innerHeight;
    const popupWidth = Math.min(380, Math.max(280, rect.width), Math.max(0, width - 16));
    const below = Math.max(0, topEdge + height - rect.bottom - 14);
    const above = Math.max(0, rect.top - topEdge - 14);
    const desiredHeight = Math.min(360, dialog.scrollHeight || 300);
    const flip = below < desiredHeight && above > below;
    const popupHeight = Math.min(desiredHeight, flip ? above : below, Math.max(0, height - 16));
    host.style.width = `${popupWidth}px`;
    host.style.maxHeight = `${popupHeight}px`;
    host.style.left = `${Math.max(leftEdge + 8, Math.min(rect.left, leftEdge + width - popupWidth - 8))}px`;
    host.style.top = `${Math.max(topEdge + 8, Math.min(flip ? rect.top - popupHeight - 6 : rect.bottom + 6, topEdge + height - popupHeight - 8))}px`;
  }
  function show(element, field) {
    dismiss();
    mount();
    target = element; snapshot = field; host.hidden = false; controlsMode(false); observe();
    if (field.rawValue !== '') {
      render(); setStatus('Your answer is kept. Clear the field to choose a suggestion.'); return;
    }
    loading = true; requestId = uniqueId();
    const version = epoch, expected = fingerprint(field), request = requestId;
    render(); setStatus('Finding saved answers…');
    message({type: 'JOB_INLINE_QUERY', fieldId: field.id, handle: field.handle, requestId: request}).then(response => {
      if (!isCurrent(version, element, expected)) {
        if (response?.sessionId) cancelSession(response.sessionId, request);
        return;
      }
      if (!response?.ok || !response.sessionId) throw new Error(response?.error || 'Saved answers are unavailable. Click the field to retry.');
      if (response.requestId !== request) throw new Error('Saved answers changed. Click the field to retry.');
      sessionId = response.sessionId; answers = (response.candidates || []).slice(0, 3); index = -1; loading = false;
      render();
      setStatus(response.error || (answers.length ? 'Choose an answer to review before using it.' : 'No saved answers. Generate an answer or edit in panel.'), response.error ? 'error' : 'info');
      if (searching) scheduleSearch();
    }).catch(error => {
      if (!isCurrent(version, element, expected)) return;
      loading = false; retry = true; render(); setStatus(error.message, 'error');
    });
  }
  function activate(element) {
    if (disposed || composing || restoringFocus) return;
    if (element === host) return;
    const field = eligible(element);
    if (!field) { dismiss(); return; }
    if (target === element && !host?.hidden && fingerprint(field) === fingerprint(snapshot) && !retry) return;
    show(element, field);
  }
  function accept() {
    const answer = answers[index];
    if (loading || !answer || !sessionId || !isCurrent(epoch, target, fingerprint(snapshot)) || snapshot.rawValue !== '') return;
    const token = uniqueId(), version = epoch, element = target;
    acceptance = {token, element, expected: fingerprint(snapshot), answer: String(answer.answer), sessionId, candidateId: answer.candidateId};
    // Return focus before disabling/hiding the activated popup button.
    restoringFocus = true; element.focus({preventScroll: true}); restoringFocus = false;
    controlsMode(false);
    if (!isCurrent(version, element, fingerprint(snapshot))) { acceptance = null; return; }
    loading = true; requestId = uniqueId();
    const request = requestId;
    index = -1; render(); setStatus('Applying reviewed answer… Tab again to move on and cancel the pending write.');
    message({type: 'JOB_INLINE_ACCEPT', sessionId, requestId: request, candidateId: answer.candidateId, acceptanceToken: token}).then(response => {
      if (epoch !== version || target !== element) return;
      acceptance = null;
      if (!response?.ok) throw new Error(response?.error || 'The answer could not be applied. Click the field to retry.');
      dismiss();
    }).catch(error => {
      if (epoch !== version || target !== element) return;
      acceptance = null; loading = false;
      const busy = /Fill is in progress|Application is busy/i.test(error.message);
      retry = !busy;
      if (busy) index = answers.indexOf(answer);
      else answers = [];
      render(); setStatus(error.message, 'error');
    });
  }
  function beforeFill({field, element, decision, acceptanceToken} = {}) {
    if (acceptanceToken === undefined) return true;
    if (!acceptance || acceptance.token !== acceptanceToken) return false;
    const pending = acceptance;
    acceptance = null;
    return pending.element === element && activeField() === element && target === element && sessionId === pending.sessionId
      && fingerprint(eligible(element)) === pending.expected && fingerprint(field) === pending.expected
      && decision?.fieldId === field.id && String(decision.value) === pending.answer;
  }
  function generateAnswer() {
    if (loading || !sessionId || !isCurrent(epoch, target, fingerprint(snapshot)) || snapshot.rawValue !== '') return;
    const version = epoch, element = target, expected = fingerprint(snapshot), session = sessionId, selected = index;
    loading = true; index = -1; requestId = uniqueId(); const request = requestId;
    render(); setStatus('Generating an answer…');
    message({type: 'JOB_INLINE_GENERATE', sessionId, requestId}).then(response => {
      if (!isCurrent(version, element, expected)) return;
      if (!response?.ok) throw new Error(response?.error || 'Generation is unavailable. Open the panel for help.');
      if (response.sessionId !== session || response.requestId !== request) return;
      if (Array.isArray(response.candidates)) answers = response.candidates;
      loading = false; render();
      setStatus(response.error || response.generatedSuggestion?.missingContext || 'Choose a draft to review before using it.', response.error ? 'error' : 'info');
    }).catch(error => {
      if (!isCurrent(version, element, expected)) return;
      if (/Fill is in progress|Application is busy/i.test(error.message)) index = selected;
      loading = false; render(); setStatus(error.message, 'error');
    });
  }
  function editInPanel() {
    if (loading || !sessionId || !isCurrent(epoch, target, fingerprint(snapshot))) return;
    const payload = {type: 'JOB_INLINE_EDIT_IN_PANEL', sessionId};
    if (answers[index]) payload.candidateId = answers[index].candidateId;
    const element = target, field = snapshot, expected = fingerprint(snapshot);
    // The panel owns the continuing guarded session. Only this display/token is revoked.
    const response = message(payload);
    dismiss({retainSession: true});
    const version = epoch;
    response.then(reply => {
      if (!reply?.error) return;
      if (disposed || epoch !== version || deepActiveElement(document) !== element || fingerprint(eligible(element)) !== expected) return;
      target = element; snapshot = field; retry = true; host.hidden = false;
      observe(); render(); setStatus(reply.error, 'error');
    }).catch(() => {
      if (disposed || epoch !== version || deepActiveElement(document) !== element || fingerprint(eligible(element)) !== expected) return;
      target = element; snapshot = field; retry = true; host.hidden = false;
      observe(); render(); setStatus('Open the extension toolbar button to continue editing', 'error');
    });
  }
  function keydown(event) {
    if (composing || event.isComposing || event.keyCode === 229 || !target || host.hidden) return;
    const inPopup = event.composedPath().includes(host);
    if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault(); dismiss({returnFocus: inPopup}); return;
    }
    if (inPopup && shadow.activeElement === searchInput && event.key === 'Enter' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      if (retry) scheduleSearch();
      else if (answers.length && !loading) select(index < 0 ? 0 : index);
      return;
    }
    if (inPopup && shadow.activeElement === searchInput && event.key === 'ArrowDown' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
      if (answers.length && !loading) { event.preventDefault(); select(index < 0 ? 0 : index); list.focus(); }
      return;
    }
    if (event.key === 'ArrowDown' && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !inPopup) {
      event.preventDefault(); controlsMode(true); searchInput.focus(); return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'Tab') {
      if (acceptance) { dismiss(); return; }
      if (!inPopup && index >= 0 && !loading) { event.preventDefault(); accept(); }
      return;
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && answers.length && !loading
      && (!inPopup || shadow.activeElement === list)) {
      event.preventDefault(); select(index < 0 ? (event.key === 'ArrowDown' ? 0 : answers.length - 1) : index + (event.key === 'ArrowDown' ? 1 : -1));
    }
  }
  listen(document, 'focusin', event => {
    if (event.target === host && target?.isConnected && !host.hidden) {
      document.__jobApplicationInlineFocusAnchor = target;
      controlsMode(true);
    } else {
      delete document.__jobApplicationInlineFocusAnchor;
      if (shadow) controlsMode(false);
    }
    activate(event.composedPath().includes(host) ? host : eventControl(event));
  });
  listen(document, 'click', event => { if (!event.composedPath().includes(host)) activate(event.composedPath().includes(host) ? host : eventControl(event)); });
  listen(document, 'pointerdown', event => {
    if (target && eventControl(event) !== target && !event.composedPath().includes(host)) dismiss();
  }, true);
  listen(document, 'focusout', event => {
    if (restoringFocus || !target) return;
    if (event.relatedTarget === host || event.relatedTarget === target) return;
    if (event.composedPath().includes(host) && event.relatedTarget?.getRootNode() === shadow) return;
    dismiss();
  });
  listen(document, 'keydown', keydown, true);
  listen(document, 'input', event => {
    if (document.__jobApplicationFilling || eventControl(event)?.__jobApplicationAutofillDispatch || composing) return;
    if (eventControl(event) === target || eventControl(event) === deepActiveElement(document)) { acceptance = null; activate(event.composedPath().includes(host) ? host : eventControl(event)); }
  });
  listen(document, 'change', event => {
    if (eventControl(event) === target && !document.__jobApplicationFilling && !eventControl(event).__jobApplicationAutofillDispatch) { acceptance = null; activate(event.composedPath().includes(host) ? host : eventControl(event)); }
  });
  listen(document, 'compositionstart', event => {
    composing = true;
    if (event.composedPath().includes(searchInput)) scheduleSearch();
    else dismiss();
  });
  listen(document, 'compositionend', event => {
    composing = false;
    if (event.composedPath().includes(searchInput)) scheduleSearch();
  });
  listen(view, 'pagehide', () => dismiss());
  listen(document, 'scroll', schedulePosition, true);
  listen(view, 'resize', schedulePosition);
  listen(view.visualViewport, 'resize', schedulePosition);
  listen(view.visualViewport, 'scroll', schedulePosition);
  function withExplicitFocus(focus) {
    // The worker is revealing a reviewed destination, not requesting new suggestions.
    // DOM focus events are synchronous; ordinary user focus resumes after this call.
    const previous = restoringFocus;
    restoringFocus = true;
    try { return focus(); }
    finally { restoringFocus = previous; }
  }
  return {activeField, beforeFill, withExplicitFocus, refresh() { if (!disposed) activate(deepActiveElement(document)); }, dispose() { if (disposed) return; dismiss(); disposed = true; listeners.forEach(remove => remove()); host?.remove(); }};
}





let runtimeDisconnected = false;
async function sendRuntimeMessage(message) {
  if (runtimeDisconnected) throw new Error('Extension context invalidated.');
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (/Extension context invalidated/i.test(error.message)) runtimeDisconnected = true;
    throw error;
  }
}

function notifyNavigation() {
  waitForDocumentSettled(document).then(() => sendRuntimeMessage({ type: 'JOB_APP_NAVIGATED' })).catch(() => {});
}

const CONTENT_VERSION = 'autofill-ux-7';
if (!globalThis.__jobApplicationAutofillInstalled) {
  globalThis.__jobApplicationAutofillInstalled = CONTENT_VERSION;
  let inline = null;
  let learning = null;
  let active = false;
  let resolveReady;
  let ready = false;
  let forcedState = null;
  let selectionRequest = null;
  let selectionTimer = null;
  let pageObserver = null;
  let pageChangeTimer = null;
  let observedPage = null;

  function formShape() {
    return withDomSnapshot(document, index => {
      // Mutation observers do not cross shadow boundaries. Refresh the roots
      // after structural changes so newly inserted component forms are watched.
      pageObserver?.disconnect();
      for (const root of index.roots) pageObserver?.observe(root, {
        subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['hidden', 'aria-hidden', 'class', 'style', 'disabled', 'required', 'aria-label'],
      });
      const inspection = inspectDocument(document);
      return JSON.stringify([document.location.href, inspection.destination,
        inspection.fields.map(field => [field.id, field.label, field.type, field.options]),
        inspection.actions.map(action => [action.kind, action.label])]);
    });
  }

  function schedulePageCheck() {
    if (!active) return;
    clearTimeout(pageChangeTimer);
    pageChangeTimer = setTimeout(() => {
      if (!active) return;
      const current = formShape();
      if (current === observedPage) return;
      observedPage = current;
      sendRuntimeMessage({type: 'JOB_APP_NAVIGATED'}).catch(() => {});
    }, 350);
  }
  document.defaultView.addEventListener('popstate', schedulePageCheck);
  document.defaultView.addEventListener('hashchange', schedulePageCheck);
  const readyPromise = new Promise(resolve => { resolveReady = resolve; });

  function cancelSelection() {
    selectionRequest = null;
    clearTimeout(selectionTimer);
  }

  function invalidateDestination() {
    cancelSelection();
    clearApplicationSelection(document);
  }
  document.defaultView.addEventListener('pagehide', invalidateDestination);
  document.defaultView.addEventListener('popstate', invalidateDestination);
  document.defaultView.addEventListener('hashchange', invalidateDestination);
  document.addEventListener('click', event => {
    const request = selectionRequest;
    if (!active || !request || !event.isTrusted || Date.now() > request.expiresAt) return;
    const control = eventControl(event);
    const destination = selectApplicationRegion(document, control);
    if (!destination?.regionId && !selectApplicationField(document, control)) return;
    cancelSelection();
    sendRuntimeMessage({type: 'JOB_APP_FORM_SELECTED', token: request.token,
      destination: destination || applicationDestination(document), fieldOnly: !destination?.regionId}).catch(() => {});
  }, true);

  function destinationMatches(expected) {
    if (!expected) return true;
    const current = applicationDestination(document);
    return expected.documentId === current.documentId && expected.regionId === current.regionId;
  }

  async function inspectWhenReady() {
    const start = Date.now();
    let settled;
    let inspection;
    do {
      settled = await waitForDocumentSettled(document, {minWaitMs: 150, quietMs: 75, timeoutMs: Math.max(1, 2500 - (Date.now() - start))});
      inspection = inspectDocument(document);
      if (inspection.fields.length || inspection.discovery?.code === 'ambiguous_form' || settled?.timedOut || Date.now() - start >= 2350) break;
    } while (Date.now() - start < 2500);
    if (settled?.timedOut && !inspection.fields.length && inspection.discovery) inspection.discovery.code = 'loading_timeout';
    return inspection;
  }

  function disable() {
    clearTimeout(pageChangeTimer);
    pageObserver?.disconnect();
    pageObserver = null;
    observedPage = null;
    invalidateDestination();
    if (inline) inline.dispose();
    if (learning) learning.dispose();
    inline = null;
    learning = null;
    active = false;
  }

  function enable() {
    if (active) return;
    active = true;
    pageObserver = new document.defaultView.MutationObserver(changes => {
      if (changes.some(change => !isExtensionElement(change.target)
        && !(change.type === 'childList' && [...change.addedNodes, ...change.removedNodes]
          .every(node => node.nodeType === 1 && node.matches('[data-job-inline-autofill]'))))) schedulePageCheck();
    });
    observedPage = formShape();
    inline = createInlineAutofill(document, {send: message => sendRuntimeMessage(message), describe: descriptorForElement});
    learning = createLearningSession(document, {
      capture: (options) => collectAnswerRecords(document, options),
      send: (message) => sendRuntimeMessage(message),
      onRevalidate: ({applicationId}) => sendRuntimeMessage({type:'JOB_APP_REVALIDATE',applicationId}),
      onFinalSubmit: ({ applicationId, records, event }) => {
        if (!isFinalApplicationSubmit(document, event)) return null;
        return sendRuntimeMessage({
          type: 'JOB_APP_FINAL_SUBMISSION',
          applicationId,
          page: inspectDocument(document).page,
          records,
        });
      },
    });
    inline.refresh();
    sendRuntimeMessage({ type: 'JOB_APP_LEARNING_STATUS' }).then((response) => {
      if (active && response?.applicationId) learning.activate(response.applicationId);
    }).catch(() => {});
  }

  function handleMessage(message, _sender, sendResponse) {
    try {
      if (message?.destination && !destinationMatches(message.destination)) {
        sendResponse({ok: false, code: 'destination_changed', error: 'The selected form changed. Retry the scan.'});
        return false;
      }
      switch (message?.type) {
        case 'JOB_APP_SELECT_FORM':
          if (!active) { sendResponse({ok: false, disabled: true}); break; }
          cancelSelection();
          selectionRequest = {token: message.token, expiresAt: Math.min(message.expiresAt, Date.now() + 60_000)};
          selectionTimer = setTimeout(cancelSelection, Math.max(0, selectionRequest.expiresAt - Date.now()));
          sendResponse({ok: true, destination: applicationDestination(document)});
          break;
        case 'JOB_APP_CANCEL_FORM_SELECTION':
          cancelSelection();
          sendResponse({ok: true});
          break;
        case 'JOB_APP_SITE_STATE_CHANGED':
          forcedState = Boolean(message.enabled);
          if (message.enabled) enable(); else disable();
          sendResponse({ok: true, enabled: active});
          break;
        case 'JOB_APP_PING':
          sendResponse({ ok: true, version: CONTENT_VERSION });
          break;
        case 'JOB_APP_INSPECT':
          if (!active) { sendResponse({ok: false, disabled: true}); break; }
          inspectWhenReady().then(inspection => sendResponse({ ok: true, inspection, version: CONTENT_VERSION }))
            .catch((error) => sendResponse({ ok: false, code: 'inspection_error', error: error.message }));
          return true;
        case 'JOB_APP_INSPECT_INLINE': {
          if (!active) { sendResponse({ok: false, disabled: true}); break; }
          let focused, focusInspected = false;
          const inspection = withDomSnapshot(document, () => {
            const current = inspectDocument(document);
            if (current.fields.some(field => field.id === message.fieldId && field.handle === message.handle)) {
              focused = descriptorForElement(document, inline.activeField());
              focusInspected = true;
            }
            return current;
          });
          inspection.page.url = document.location.href;
          // A field outside the selected region needs its own temporary selection and fresh snapshot.
          if (!focusInspected) focused = descriptorForElement(document, inline.activeField());
          if (focused && !inspection.fields.some(field => field.handle === focused.handle)) inspection.fields.push(focused);
          sendResponse({ok: true, inspection, focusedFieldId: focused?.id ?? null, focusedHandle: focused?.handle ?? null,
            rawValue: focused?.rawValue ?? null, editRevision: focused?.editRevision ?? null});
          break;
        }
        case 'JOB_APP_APPLY': {
          if (!active) { sendResponse({ok: false, disabled: true, result: {applied: [], kept: [], reviewRequired: [], unresolved: [], failed: []}}); break; }
          const destination = message.destination || applicationDestination(document);
          if (!destination.regionId) {
            const focused = descriptorForElement(document, inline.activeField());
            const decisions = message.decisions || [];
            if (decisions.length !== 1 || !focused || !decisions[0].approved || decisions[0].handle !== focused.handle) {
              sendResponse({ok: false, code: 'destination_changed', error: 'Select a form, or use suggestions for the focused field.'});
              break;
            }
            selectApplicationField(document, inline.activeField());
          }
          if (message.applicationId) learning.activate(message.applicationId);
          applyDecisions(document, message.decisions || [], {deadline: message.deadline ?? Infinity,
            beforeFill: args => active && destinationMatches(destination) && inline.beforeFill({...args, acceptanceToken: message.approvalGuard?.acceptanceToken})})
            .then((result) => sendResponse({ ok: true, result }))
            .catch((error) => sendResponse({ ok: false, error: error.message }));
          return true;
        }
        case 'JOB_APP_CAPTURE':
          if (!active) { sendResponse({ok: false, disabled: true, records: []}); break; }
          sendResponse({ ok: true, records: collectAnswerRecords(document, { finalize: message.finalize === true }) });
          break;
        case 'JOB_APP_VALIDATE':
          if (!active) { sendResponse({ok: false, disabled: true, validation: {ok: false, requiredEmpty: [], invalid: []}}); break; }
          sendResponse({ ok: true, validation: validateDocument(document) });
          break;
        case 'JOB_APP_FOCUS':
          if (!active) { sendResponse({ok: false, disabled: true}); break; }
          sendResponse({ ok: inline.withExplicitFocus(() => focusField(document, message.fieldId, message.handle)) });
          break;
        case 'JOB_APP_CLICK_NEXT':
          if (!active) { sendResponse({ok: false, disabled: true}); break; }
          learning.flush().then(() => {
            if (!destinationMatches(message.destination)) { sendResponse({ok: false, code: 'destination_changed'}); return; }
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
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!ready && message?.type !== 'JOB_APP_PING' && message?.type !== 'JOB_APP_SITE_STATE_CHANGED') {
      readyPromise.then(() => handleMessage(message, sender, sendResponse));
      return true;
    }
    return handleMessage(message, sender, sendResponse);
  });

  sendRuntimeMessage({ type: 'JOB_APP_SITE_STATUS' }).then((response) => {
    const enabled = forcedState == null
      ? response?.enabled === true
      : forcedState;
    if (!enabled) disable();
    else enable();
    ready = true;
    resolveReady();
  }).catch(() => {
    disable();
    ready = true;
    resolveReady();
  });
}

})();
