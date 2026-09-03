(() => {
'use strict';
const HEADER_ALIASES = {
  key: ['key', 'id', 'canonical key', 'field key'],
  question: ['question', 'questions', 'field', 'label', 'canonical question', 'prompt'],
  answer: ['answer', 'answers', 'value', 'response', 'default answer'],
  aliases: ['aliases', 'alias', 'alternate questions', 'alternate labels'],
  type: ['type', 'answer type', 'field type'],
  status: ['status', 'verification', 'verified'],
  sensitivity: ['sensitivity', 'review policy', 'policy'],
  options: ['options', 'allowed options', 'choices'],
};

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

function parseCsv(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(value);
      value = '';
    } else if (char === '\n') {
      row.push(value.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      value = '';
    } else {
      value += char;
    }
  }

  if (value.length > 0 || row.length > 0 || source.endsWith(',')) {
    row.push(value.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => String(cell).trim() !== ''));
}

function findColumn(headers, logicalName) {
  const aliases = HEADER_ALIASES[logicalName];
  return headers.findIndex((header) => aliases.includes(normalizeText(header)));
}

function splitList(value = '') {
  return String(value)
    .split(/(?:\r?\n|;|\|)/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeStatus(value) {
  const normalized = normalizeText(value);
  if (['yes', 'true', 'approved', 'verified'].includes(normalized)) return 'verified';
  if (['draft', 'proposed', 'review'].includes(normalized)) return 'draft';
  return normalized || 'verified';
}

function inferSensitivity(question, key) {
  const text = normalizeText(`${key} ${question}`);
  if (/\b(consent|agree|agreement|certify|attest|attestation|privacy|terms|declaration|conflict of interest|criminal|gender|race|ethnicity|disability|veteran)\b/.test(text)) {
    return 'legal';
  }
  if (/\b(ctc|salary|compensation|notice period|sponsorship|sponsor|visa|citizenship|work authorization|reference|reason for leaving|relocat)/.test(text)) {
    return 'review';
  }
  return 'safe';
}

function rowsToRecords(rows, source = 'google-sheet') {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const headers = rows[0].map((header) => String(header).trim());
  let columns = Object.fromEntries(
    Object.keys(HEADER_ALIASES).map((name) => [name, findColumn(headers, name)]),
  );
  let dataRows = rows.slice(1);

  const hasHeaders = columns.answer >= 0 && (columns.question >= 0 || columns.key >= 0);
  if (!hasHeaders) {
    const hasKeyValueRows = rows.some((cells) => String(cells[0] ?? '').trim() && String(cells[1] ?? '').trim());
    if (!hasKeyValueRows) return [];
    columns = {
      key: 0,
      question: 0,
      answer: 1,
      aliases: -1,
      type: -1,
      status: -1,
      sensitivity: -1,
      options: -1,
    };
    dataRows = rows;
  }

  return dataRows.flatMap((cells) => {
    const cell = (column) => (column >= 0 ? String(cells[column] ?? '').trim() : '');
    const question = cell(columns.question) || cell(columns.key);
    const answer = cell(columns.answer);
    if (!question || !answer) return [];
    const key = slugify(cell(columns.key) || question);
    return [{
      key,
      question,
      answer,
      aliases: splitList(cell(columns.aliases)),
      type: normalizeText(cell(columns.type)) || 'text',
      status: normalizeStatus(cell(columns.status)),
      sensitivity: normalizeText(cell(columns.sensitivity)) || inferSensitivity(question, key),
      options: splitList(cell(columns.options)),
      source,
    }];
  });
}

function buildGoogleSheetCsvUrl(input) {
  const url = new URL(String(input).trim());
  const idMatch = url.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
  if (!idMatch) throw new Error('Enter a valid Google Sheets URL.');
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
  const gid = url.searchParams.get('gid') || fragment.get('gid') || '0';
  return `https://docs.google.com/spreadsheets/d/${idMatch[1]}/gviz/tq?tqx=out:csv&gid=${encodeURIComponent(gid)}`;
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

function candidateLabels(record) {
  return [record.key?.replace(/_/g, ' '), record.question, ...(record.aliases || [])]
    .map(normalizeText)
    .filter(Boolean);
}

function chooseRecord(field, records) {
  if (!Array.isArray(records) || records.length === 0) return null;
  const fieldTexts = [field.label, field.name, field.id, field.placeholder]
    .map(normalizeText)
    .filter(Boolean);
  const autocomplete = normalizeText(String(field.autocomplete || '').split(' ').at(-1));
  const preferredKeys = AUTOCOMPLETE_KEYS[autocomplete] || [];

  if (preferredKeys.length) {
    const exact = records.find((record) => preferredKeys.includes(slugify(record.key)));
    if (exact) return { record: exact, confidence: 'exact', score: 1, reason: `autocomplete:${autocomplete}` };
  }

  let best = null;
  for (const record of records) {
    for (const fieldText of fieldTexts) {
      for (const candidate of candidateLabels(record)) {
        let score = 0;
        if (fieldText === candidate) score = 1;
        else if (fieldText.includes(candidate) || candidate.includes(fieldText)) score = 0.9;
        else score = similarity(fieldText, candidate);
        if (!best || score > best.score) best = { record, score, reason: `label:${candidate}` };
      }
    }
  }

  if (!best || best.score < 0.5) return null;
  return {
    ...best,
    confidence: best.score >= 0.9 ? 'exact' : best.score >= 0.7 ? 'high' : 'medium',
  };
}

function shouldAutofill(record) {
  return normalizeText(record?.status) === 'verified'
    && normalizeText(record?.sensitivity || 'safe') === 'safe';
}


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

function scanAndFillDocument(document, records, { fill = false, overwrite = false } = {}) {
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


if (!globalThis.__jobApplicationAutofillInstalled) {
  globalThis.__jobApplicationAutofillInstalled = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'JOB_AUTOFILL_PING') {
      sendResponse({ ok: true });
      return false;
    }
    if (!['JOB_AUTOFILL_SCAN', 'JOB_AUTOFILL_FILL'].includes(message?.type)) return false;

    try {
      const report = scanAndFillDocument(document, message.records || [], {
        fill: message.type === 'JOB_AUTOFILL_FILL',
        overwrite: Boolean(message.overwrite),
      });
      report.page = { title: document.title, url: location.href };
      sendResponse({ ok: true, report });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return false;
  });
}

})();
