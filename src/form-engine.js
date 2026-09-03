import { chooseRecord, inferSensitivity, normalizeText, shouldAutofill, slugify } from './core.js';

function textFromIds(document, ids = '') {
  return String(ids)
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent?.trim() || '')
    .filter(Boolean)
    .join(' ');
}

function labelFor(document, element) {
  if (element.type === 'radio' || element.type === 'checkbox') {
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

function describeField(document, element) {
  return {
    label: labelFor(document, element),
    name: element.name || '',
    id: element.id || '',
    placeholder: element.placeholder || '',
    autocomplete: element.autocomplete || '',
    type: element.tagName === 'SELECT' ? 'select' : (element.type || element.tagName.toLowerCase()),
  };
}

function dispatchFormEvents(element) {
  const view = element.ownerDocument.defaultView;
  for (const eventName of ['input', 'change', 'blur']) {
    element.dispatchEvent(new view.Event(eventName, { bubbles: true }));
  }
}

function setTextValue(element, value) {
  const view = element.ownerDocument.defaultView;
  const prototype = element.tagName === 'TEXTAREA'
    ? view.HTMLTextAreaElement?.prototype
    : view.HTMLInputElement?.prototype;
  const setter = prototype && Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter) setter.call(element, String(value));
  else element.value = String(value);
  dispatchFormEvents(element);
  return element.value === String(value);
}

function setSelectValue(element, answer) {
  const expected = normalizeText(answer);
  const option = [...element.options].find((candidate) => (
    normalizeText(candidate.value) === expected || normalizeText(candidate.textContent) === expected
  ));
  if (!option) return false;
  element.value = option.value;
  dispatchFormEvents(element);
  return element.value === option.value;
}

function optionText(element) {
  const label = [...(element.labels || [])].map((item) => item.textContent || '').join(' ');
  return label || element.value || element.getAttribute('aria-label') || '';
}

function setRadioGroup(document, element, answer) {
  const escapedName = globalThis.CSS?.escape ? CSS.escape(element.name) : element.name.replace(/["\\]/g, '\\$&');
  const group = element.name
    ? [...document.querySelectorAll(`input[type="radio"][name="${escapedName}"]`)]
    : [element];
  const expected = normalizeText(answer);
  const option = group.find((candidate) => (
    normalizeText(candidate.value) === expected || normalizeText(optionText(candidate)) === expected
  ));
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

function hasValue(element) {
  if (element.type === 'checkbox' || element.type === 'radio') return element.checked;
  return String(element.value || '').trim() !== '';
}

function fieldValue(element) {
  if (element.type === 'checkbox') return element.checked ? 'Yes' : 'No';
  if (element.type === 'radio') return element.checked ? (optionText(element) || element.value) : '';
  return String(element.value || '').trim();
}

function fieldIdentity(element, index) {
  return element.id || element.name || `field_${index}`;
}

function formElements(document) {
  return [...document.querySelectorAll('input, textarea, select')].filter(isSupported);
}

export function snapshotFormValues(document) {
  const values = new Map();
  const seenRadioGroups = new Set();
  for (const [index, element] of formElements(document).entries()) {
    if (element.type === 'radio' && element.name) {
      if (seenRadioGroups.has(element.name)) continue;
      seenRadioGroups.add(element.name);
    }
    values.set(fieldIdentity(element, index), fieldValue(element));
  }
  return values;
}

export function collectChangedResponses(document, initialValues) {
  const records = [];
  const seenRadioGroups = new Set();
  for (const [index, element] of formElements(document).entries()) {
    if (element.type === 'radio' && element.name) {
      if (seenRadioGroups.has(element.name)) continue;
      seenRadioGroups.add(element.name);
    }
    const answer = fieldValue(element);
    const identity = fieldIdentity(element, index);
    if (!answer || answer === initialValues.get(identity)) continue;
    const field = describeField(document, element);
    const key = slugify(field.label || field.name || field.id || identity);
    records.push({
      key,
      question: field.label || field.name || field.id || 'Unlabelled field',
      answer,
      aliases: [],
      type: field.type,
      status: 'draft',
      sensitivity: inferSensitivity(field.label, key),
      options: element.tagName === 'SELECT' ? [...element.options].map((option) => option.textContent.trim()).filter(Boolean) : [],
      source: `learned:${document.location.href}`,
    });
  }
  return records;
}

function isEmailTemplateField(field) {
  return /cover letter|covering letter|application message|email body|message/i.test(field.label || '');
}

function fillElement(document, element, answer) {
  if (element.tagName === 'SELECT') return setSelectValue(element, answer);
  if (element.type === 'radio') return setRadioGroup(document, element, answer);
  if (element.type === 'checkbox') return setCheckbox(element, answer);
  return setTextValue(element, answer);
}

function reportItem(field, match, element, extra = {}) {
  return {
    label: field.label || field.name || field.id || 'Unlabelled field',
    key: match?.record?.key || null,
    answer: match?.record?.answer || null,
    confidence: match?.confidence || null,
    reason: match?.reason || null,
    required: Boolean(element.required),
    ...extra,
  };
}

function isSupported(element) {
  if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) return false;
  if (element.disabled || element.readOnly) return false;
  return !['hidden', 'password', 'file', 'submit', 'button', 'reset', 'image'].includes(element.type);
}

export function scanAndFillDocument(document, records, { fill = false, overwrite = false, includeEmailTemplates = false } = {}) {
  const report = {
    scanned: [],
    filled: [],
    review: [],
    unknown: [],
    unchanged: [],
    failed: [],
    requiredEmpty: [],
  };
  const seenRadioGroups = new Set();
  const elements = [...document.querySelectorAll('input, textarea, select')].filter(isSupported);

  for (const element of elements) {
    if (element.type === 'radio' && element.name) {
      if (seenRadioGroups.has(element.name)) continue;
      seenRadioGroups.add(element.name);
    }
    const field = describeField(document, element);
    let match = chooseRecord(field, records);
    if (match?.record?.type === 'email-template' && !isEmailTemplateField(field)) {
      match = chooseRecord(field, records.filter((record) => record.type !== 'email-template'));
    }
    const item = reportItem(field, match, element, { currentValue: element.value || '' });
    report.scanned.push(item);

    if (!match) {
      report.unknown.push(item);
      continue;
    }
    const templateAllowed = includeEmailTemplates && match.record.type === 'email-template';
    if (!shouldAutofill(match.record) && !templateAllowed) {
      report.review.push(item);
      continue;
    }
    if (hasValue(element) && !overwrite) {
      report.unchanged.push(item);
      continue;
    }
    if (!fill) continue;

    if (fillElement(document, element, match.record.answer)) {
      report.filled.push({ ...item, currentValue: match.record.answer });
    } else {
      report.failed.push(item);
    }
  }

  report.requiredEmpty = elements
    .filter((element) => element.required && !hasValue(element))
    .map((element) => ({
      label: labelFor(document, element) || element.name || element.id || 'Unlabelled field',
      type: element.type || element.tagName.toLowerCase(),
    }));
  return report;
}
