(() => {
'use strict';
const AUTOCOMPLETE_KEYS = {
  email: ['email'],
  tel: ['phone', 'phone_number', 'mobile'],
  name: ['full_name', 'name'],
  'given-name': ['first_name', 'given_name'],
  'family-name': ['last_name', 'family_name', 'surname'],
  country: ['country'],
  'country-name': ['country'],
  'address-level1': ['state', 'region'],
  'address-level2': ['city'],
  'postal-code': ['postal_code', 'zip_code', 'pincode'],
  'street-address': ['address', 'street_address'],
  organization: ['current_employer', 'employer', 'company'],
  url: ['website', 'linkedin', 'portfolio', 'github'],
};

const SENSITIVITIES = new Set(['safe', 'review', 'legal']);

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
  const key = slugify(record.key || question);
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
  if (alternatives.length) normalized.alternatives = alternatives;
  return normalized;
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

function chooseRecord(field = {}, records = []) {
  if (!Array.isArray(records) || records.length === 0) return null;
  const fieldTexts = [field.label, field.name, field.id, field.placeholder]
    .map(normalizeText)
    .filter(Boolean);
  const autocomplete = normalizeText(String(field.autocomplete || '').split(' ').at(-1));
  const preferredKeys = AUTOCOMPLETE_KEYS[autocomplete] || [];
  if (preferredKeys.length) {
    const exact = records.find((record) => preferredKeys.includes(slugify(record.key)) && String(record.answer ?? '').trim());
    if (exact) return { record: exact, confidence: 'exact', score: 1, reason: `autocomplete:${autocomplete}` };
  }

  let best = null;
  for (const record of records) {
    if (!String(record.answer ?? '').trim()) continue;
    for (const fieldText of fieldTexts) {
      for (const candidate of candidateLabels(record)) {
        const compactFieldText = compactText(fieldText);
        const compactCandidate = compactText(candidate);
        const score = fieldText === candidate || compactFieldText === compactCandidate
          ? 1
          : fieldText.includes(candidate)
            || candidate.includes(fieldText)
            || compactFieldText.includes(compactCandidate)
            || compactCandidate.includes(compactFieldText)
            ? 0.9
            : similarity(fieldText, candidate);
        if (!best || score > best.score) best = { record, score, reason: `label:${candidate}` };
      }
    }
  }

  if (!best || best.score < 0.5) return null;
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
    const normalized = normalizeText(text);
    if (!field.options.some((option) => normalizeText(option) === normalized)) {
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
    });
  }
  return [...merged.values()];
}


const IGNORED_TYPES = new Set(['hidden', 'password', 'file', 'submit', 'button', 'reset', 'image']);
const SECRET_MARKER = /(?:password|passcode|passwd|pwd|secret|token|csrf|auth[_-]?token)/i;
const CUSTOM_WIDGET_SELECTOR = '[role="combobox"], button[aria-haspopup="listbox"]';
const EMPTY_CUSTOM_WIDGET_VALUE = /^(?:choose|select)\b/i;
const CUSTOM_WIDGET_PROMPT_LABEL = /^(?:choose|select)(?:\s+(?:one|an?\s+option|an?\s+answer|a\s+value))?$/i;

function textFromIds(document, ids = '') {
  return String(ids)
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent?.trim() || '')
    .filter(Boolean)
    .join(' ');
}

function labelFor(document, element) {
  if (element.type === 'radio') {
    const legend = element.closest('fieldset')?.querySelector('legend')?.textContent?.trim();
    if (legend) return legend;
  }
  const nativeLabel = [...(element.labels || [])]
    .map((label) => label.textContent?.trim())
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

function customWidgetElements(document) {
  return [...document.querySelectorAll(CUSTOM_WIDGET_SELECTOR)]
    .filter((element) => isVisible(element))
    .filter((element) => element.closest('form, main, [role="main"]') || hasNearbyFormControl(element))
    .filter((element) => element.getAttribute('aria-label') || element.getAttribute('name') || hasNearbyFormControl(element));
}

function hasNearbyFormControl(element) {
  return [...(element.parentElement?.children || [])]
    .some((sibling) => sibling !== element && ['INPUT', 'TEXTAREA', 'SELECT'].includes(sibling.tagName));
}

function customWidgetValue(element) {
  const value = String(element.getAttribute('aria-valuetext') || element.textContent || '').replace(/\s+/g, ' ').trim();
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
    .map((label) => visibleText(label))
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

function customWidgetLabel(document, element) {
  const associated = associatedLabelText(document, element);
  if (associated) return associated;
  const labelledBy = textFromIds(document, element.getAttribute('aria-labelledby'));
  if (labelledBy) return labelledBy;
  const fieldGroupLabel = nearestFieldGroupLabel(element);
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

function customWidgetOptions(document, element) {
  const controlledId = element.getAttribute('aria-controls');
  const controlled = controlledId ? document.getElementById(controlledId) : null;
  const listboxes = controlled?.matches?.('[role="listbox"]')
    ? [controlled]
    : [...document.querySelectorAll('[role="listbox"]')];
  return listboxes
    .filter((listbox) => isVisible(listbox))
    .flatMap((listbox) => [...listbox.querySelectorAll('[role="option"]')])
    .filter((option) => isVisible(option));
}

function fieldIdentity(element, index) {
  return element.id || element.name || `field_${index}`;
}

function formElements(document) {
  return [...document.querySelectorAll('input, textarea, select')].filter((element) => isSupported(element) && isVisible(element));
}

function uniqueFields(document) {
  const fields = [];
  const seenRadioGroups = new Set();
  for (const [index, element] of formElements(document).entries()) {
    if (element.type === 'radio' && element.name) {
      if (seenRadioGroups.has(element.name)) continue;
      seenRadioGroups.add(element.name);
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
    const group = formElements(document).filter((candidate) => candidate.type === 'radio' && candidate.name === element.name);
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
  if (element.type === 'checkbox') return element.checked ? 'Yes' : '';
  if (element.type === 'radio') return element.checked ? optionText(element) : '';
  if (element.tagName === 'SELECT') {
    const selected = element.selectedOptions?.[0];
    return selected?.value ? selected.textContent.trim() : '';
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
  const type = element.tagName === 'SELECT' ? 'select' : element.tagName === 'TEXTAREA' ? 'textarea' : (element.type || 'text');
  return {
    id: fieldIdentity(element, index),
    label: labelFor(document, element),
    type,
    autocomplete: element.autocomplete || '',
    required: Boolean(element.required),
    currentValue: fieldValue(document, element),
    options: fieldOptions(document, element),
    constraints: constraintsFor(element),
  };
}

function collectFieldDescriptors(document) {
  const nativeFields = uniqueFields(document).map(({ element, index }) => describeField(document, element, index));
  const customFields = customWidgetElements(document)
    .filter((element, index) => !nativeFields.some((field) => field.id === fieldIdentity(element, index)))
    .map((element, index) => ({
      id: fieldIdentity(element, index),
      label: customWidgetLabel(document, element),
      type: 'select',
      widget: 'custom',
      autocomplete: element.getAttribute('autocomplete') || '',
      required: customWidgetRequired(element),
      currentValue: fieldValue(document, element),
      options: fieldOptions(document, element),
      constraints: {},
    }));
  return [...nativeFields, ...customFields];
}

function dispatchFormEvents(element) {
  const view = element.ownerDocument.defaultView;
  for (const eventName of ['input', 'change', 'blur']) {
    element.dispatchEvent(new view.Event(eventName, { bubbles: true }));
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

function setSelectValue(element, answer) {
  const expected = normalizeText(answer);
  const option = [...element.options].find((candidate) => normalizeText(candidate.value) === expected || normalizeText(candidate.textContent) === expected);
  if (!option) return false;
  element.value = option.value;
  dispatchFormEvents(element);
  return element.value === option.value;
}

function radioGroup(document, element) {
  return formElements(document).filter((candidate) => candidate.type === 'radio' && candidate.name === element.name);
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

function waitForCustomOptions(document, element, timeoutMs = 750) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      const options = customWidgetOptions(document, element);
      if (options.length || Date.now() - startedAt >= timeoutMs) {
        resolve(options);
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

async function setCustomChoiceValue(document, element, answer) {
  element.click();
  const expected = normalizeText(answer);
  const options = await waitForCustomOptions(document, element);
  if (!options.length) return { ok: false, unresolved: true, reason: 'The custom widget did not reveal any options' };
  const matches = options.filter((option) => normalizeText(customOptionText(option)) === expected
    || normalizeText(customOptionValue(option)) === expected);
  if (matches.length !== 1) return { ok: false, unresolved: true, reason: 'The custom widget does not expose one unique exact option' };
  matches[0].click();
  const backingInput = element.parentElement?.querySelector('input, textarea');
  if (backingInput) dispatchFormEvents(backingInput);
  dispatchFormEvents(element);
  const displayed = normalizeText(fieldValue(document, element));
  const backingValue = normalizeText(backingInput?.value || '');
  if (displayed !== expected && backingValue !== expected) {
    return { ok: false, unresolved: true, reason: 'The custom widget did not accept the selected option' };
  }
  return { ok: true };
}

async function fillElement(document, element, answer) {
  if (customWidgetElements(document).includes(element)) return setCustomChoiceValue(document, element, answer);
  if (element.tagName === 'SELECT') return { ok: setSelectValue(element, answer) };
  if (element.type === 'radio') return { ok: setRadioGroup(document, element, answer) };
  if (element.type === 'checkbox') return { ok: setCheckbox(element, answer) };
  return { ok: setTextValue(element, answer) };
}

function elementsForField(document, fieldId) {
  const byId = document.getElementById(fieldId);
  if (byId && (isSupported(byId) || customWidgetElements(document).includes(byId))) return [byId];
  const customFields = customWidgetElements(document);
  const generatedCustomIndex = customFields.findIndex((element, index) => fieldIdentity(element, index) === fieldId);
  if (generatedCustomIndex >= 0) return [customFields[generatedCustomIndex]];
  return [...formElements(document), ...customFields]
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

function planDeterministicFill(fields, records, coverMessages = []) {
  return fields.map((field) => {
    const coverDecision = coverMessageDecision(field, coverMessages);
    if (coverDecision) return coverDecision;
    const match = chooseRecord(field, records);
    if (!match) {
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
  });
}

async function applyDecisions(document, decisions = []) {
  const result = { applied: [], kept: [], reviewRequired: [], unresolved: [], failed: [] };
  for (const decision of decisions) {
    const field = currentField(document, decision.fieldId);
    if (!field) {
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
    const current = field.currentValue;
    if (current && validateFillValue(field, current).ok) {
      result.kept.push({ fieldId: field.id, value: current });
      addReviewIfNeeded(result, field, decision, current);
      continue;
    }
    const validation = validateFillValue(field, decision.value);
    if (!validation.ok) {
      result.failed.push({ fieldId: field.id, label: field.label, value: decision.value, reason: validation.reason });
      continue;
    }
    const fillResult = await fillElement(document, element, decision.value);
    if (!fillResult?.ok) {
      const issue = { fieldId: field.id, label: field.label, value: decision.value, reason: fillResult?.reason || 'The page rejected this value' };
      if (fillResult?.unresolved) result.unresolved.push(issue);
      else result.failed.push(issue);
      continue;
    }
    const applied = { ...decision, field, value: decision.value };
    result.applied.push(applied);
    addReviewIfNeeded(result, field, decision, decision.value);
  }
  return result;
}

function actionLabel(element) {
  return String(element.textContent || element.value || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
}

function collectActions(document) {
  const actions = [];
  const candidates = [...document.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"]')];
  for (const [index, element] of candidates.entries()) {
    if (element.disabled || !isVisible(element)) continue;
    const label = actionLabel(element);
    if (!label) continue;
    const type = String(element.type || '').toLowerCase();
    const nextLabel = /^(next|continue|save and continue|proceed|review application|next step)\b/i.test(label);
    const formControl = element.tagName === 'BUTTON' || element.tagName === 'INPUT';
    const kind = nextLabel
      ? 'next'
        : formControl && /\b(submit|apply|finish|complete application|send application)\b/i.test(label)
        ? 'submit'
        : 'other';
    actions.push({ id: `action_${actions.length}`, label, kind, type: type || element.tagName.toLowerCase() });
  }
  return actions;
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
    page: { title: document.title || '', domain: document.location?.hostname || '' },
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
    if (element?.checkValidity && !element.checkValidity()) invalid.push({ fieldId: field.id, label: field.label, type: field.type });
  }
  return { ok: requiredEmpty.length === 0 && invalid.length === 0, requiredEmpty, invalid };
}

function collectAnswerRecords(document) {
  return collectFieldDescriptors(document)
    .filter((field) => field.currentValue)
    .map((field) => ({
      key: slugify(field.label || field.id),
      question: field.label || field.id,
      answer: field.currentValue,
      aliases: [field.label, field.id].filter(Boolean),
      type: field.type,
      sensitivity: inferSensitivity(field.label, field.id),
    }));
}

function focusField(document, fieldId) {
  const element = elementForField(document, fieldId);
  if (!element) return false;
  element.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  element.focus?.({ preventScroll: true });
  return true;
}

function findActionElement(document, actionId) {
  const actions = [...document.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"]')];
  let index = 0;
  for (const element of actions) {
    if (element.disabled || !isVisible(element) || !actionLabel(element)) continue;
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


function notifyNavigation() {
  let sent = false;
  let observer;
  const send = () => {
    if (sent) return;
    sent = true;
    observer?.disconnect();
    chrome.runtime.sendMessage({ type: 'JOB_APP_NAVIGATED' }).catch(() => {});
  };
  if (typeof MutationObserver === 'function' && document.documentElement) {
    observer = new MutationObserver(send);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  }
  setTimeout(send, 500);
}

if (!globalThis.__jobApplicationAutofillInstalled) {
  globalThis.__jobApplicationAutofillInstalled = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      switch (message?.type) {
        case 'JOB_APP_PING':
          sendResponse({ ok: true });
          break;
        case 'JOB_APP_INSPECT':
          sendResponse({ ok: true, inspection: inspectDocument(document) });
          break;
        case 'JOB_APP_APPLY':
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
        case 'JOB_APP_CLICK_NEXT':
          {
            const result = clickAction(document, message.actionId);
            if (result.ok) notifyNavigation();
            sendResponse(result);
          }
          break;
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
