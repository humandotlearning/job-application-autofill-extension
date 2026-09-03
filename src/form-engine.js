import { chooseRecord, normalizeText, shouldAutofill } from './core.js';

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

export function scanAndFillDocument(document, records, { fill = false, overwrite = false } = {}) {
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
    const match = chooseRecord(field, records);
    const item = reportItem(field, match, element, { currentValue: element.value || '' });
    report.scanned.push(item);

    if (!match) {
      report.unknown.push(item);
      continue;
    }
    if (!shouldAutofill(match.record)) {
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
