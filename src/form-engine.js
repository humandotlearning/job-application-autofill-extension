import {
  chooseRecord,
  inferSensitivity,
  normalizeText,
  shouldReviewDecision,
  slugify,
  validateFillValue,
} from './core.js';

const IGNORED_TYPES = new Set(['hidden', 'password', 'file', 'submit', 'button', 'reset', 'image']);
const SECRET_MARKER = /(?:password|passcode|passwd|pwd|secret|token|csrf|auth[_-]?token)/i;

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

export function collectFieldDescriptors(document) {
  return uniqueFields(document).map(({ element, index }) => describeField(document, element, index));
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

function fillElement(document, element, answer) {
  if (element.tagName === 'SELECT') return setSelectValue(element, answer);
  if (element.type === 'radio') return setRadioGroup(document, element, answer);
  if (element.type === 'checkbox') return setCheckbox(element, answer);
  return setTextValue(element, answer);
}

function elementsForField(document, fieldId) {
  const byId = document.getElementById(fieldId);
  if (byId && isSupported(byId)) return [byId];
  return formElements(document).filter((element) => element.name === fieldId || element.id === fieldId);
}

function elementForField(document, fieldId) {
  return elementsForField(document, fieldId)[0] || null;
}

function currentField(document, fieldId) {
  const element = elementForField(document, fieldId);
  if (!element) return null;
  const index = uniqueFields(document).findIndex(({ element: candidate }) => candidate === element);
  return describeField(document, element, Math.max(index, 0));
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

export function planDeterministicFill(fields, records) {
  return fields.map((field) => {
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

export function applyDecisions(document, decisions = []) {
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
    if (!fillElement(document, element, decision.value)) {
      result.failed.push({ fieldId: field.id, label: field.label, value: decision.value, reason: 'The page rejected this value' });
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
      : formControl && (type === 'submit' || /\b(submit|apply|finish|complete application|send application)\b/i.test(label))
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
  if ([...document.querySelectorAll('[contenteditable="true"], [role="combobox"], [aria-haspopup="listbox"]')].some(isVisible)) reasons.push('unsupported_widget');
  const nextCount = collectActions(document).filter((action) => action.kind === 'next').length;
  const submitCount = collectActions(document).filter((action) => action.kind === 'submit').length;
  if (nextCount > 1 || submitCount > 1) reasons.push('ambiguous_navigation');
  return [...new Set(reasons)];
}

export function inspectDocument(document) {
  const actions = collectActions(document);
  return {
    page: { title: document.title || '', domain: document.location?.hostname || '' },
    fields: collectFieldDescriptors(document),
    actions,
    pauseReasons: pauseReasons(document),
  };
}

export function validateDocument(document) {
  const requiredEmpty = [];
  const invalid = [];
  for (const field of collectFieldDescriptors(document)) {
    const element = elementForField(document, field.id);
    if (field.required && !field.currentValue) requiredEmpty.push({ fieldId: field.id, label: field.label, type: field.type });
    if (element?.checkValidity && !element.checkValidity()) invalid.push({ fieldId: field.id, label: field.label, type: field.type });
  }
  return { ok: requiredEmpty.length === 0 && invalid.length === 0, requiredEmpty, invalid };
}

export function collectAnswerRecords(document) {
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

export function focusField(document, fieldId) {
  const element = elementForField(document, fieldId);
  element?.focus?.();
  return Boolean(element);
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

export function clickAction(document, actionId) {
  const found = findActionElement(document, actionId);
  if (!found || found.action.kind !== 'next') return { ok: false, error: 'Navigation action is unavailable or not a validated Next control' };
  found.element.click();
  return { ok: true, action: found.action };
}

export function submitDocument(document) {
  const submits = collectActions(document).filter((action) => action.kind === 'submit');
  if (submits.length !== 1) return { ok: false, error: 'The page does not have one unambiguous submit control' };
  const found = findActionElement(document, submits[0].id);
  const form = found?.element.form;
  if (!form) return { ok: false, error: 'The validated submit control is not attached to a form' };
  let submitEvent = null;
  const listener = (event) => { submitEvent = event; };
  form.addEventListener('submit', listener, true);
  try {
    if (typeof form.requestSubmit === 'function') form.requestSubmit(found.element.type === 'submit' ? found.element : undefined);
    else if (typeof form.submit === 'function') form.submit();
    else return { ok: false, error: 'The page does not expose a form submission method' };
  } finally {
    form.removeEventListener('submit', listener, true);
  }
  if (typeof form.requestSubmit === 'function' && !submitEvent) return { ok: false, error: 'The browser did not dispatch a submit event' };
  if (submitEvent?.defaultPrevented) return { ok: false, error: 'The page prevented form submission' };
  return { ok: true };
}
