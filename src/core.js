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

export function parseCsv(text) {
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

export function inferSensitivity(question, key = '') {
  const text = normalizeText(`${key} ${question}`);
  if (/\b(consent|agree|agreement|certify|attest|attestation|privacy|terms|declaration|conflict of interest|criminal|gender|race|ethnicity|disability|veteran)\b/.test(text)) {
    return 'legal';
  }
  if (/\b(ctc|salary|compensation|notice period|sponsorship|sponsor|visa|citizenship|work authorization|reference|reason for leaving|relocat)/.test(text)) {
    return 'review';
  }
  return 'safe';
}

function derivedEmailRecords(body, source) {
  const records = [];
  const add = (key, question, answer, aliases = []) => {
    if (!answer) return;
    records.push({ key, question, answer, aliases, type: 'text', status: 'verified', sensitivity: 'safe', options: [], source: `derived:${source}` });
  };
  const phone = body.match(/(?:^|\n)\s*(\+?\d[\d\s().-]{7,}\d)\s*$/m)?.[1]?.replace(/[^\d+]/g, '');
  add('phone', 'Phone number', phone, ['Phone', 'Mobile', 'Telephone']);
  for (const [key, question, aliases, pattern] of [
    ['github', 'GitHub URL', ['GitHub', 'Github profile'], /GitHub:\s*(https?:\/\/\S+)/i],
    ['portfolio', 'Portfolio URL', ['Portfolio', 'Personal website'], /Portfolio:\s*(https?:\/\/\S+)/i],
    ['email', 'Email address', ['Email', 'E-mail'], /(?:Email|E-mail):\s*(\S+@\S+)/i],
  ]) add(key, question, body.match(pattern)?.[1]?.replace(/[),.;]+$/, ''), aliases);
  const signature = body.match(/(?:warm regards|best regards|regards|sincerely),?\s*\n\s*([A-Za-z][A-Za-z .'-]*)\s*\n\s*\+?\d/im)?.[1]?.trim();
  if (signature) {
    const parts = signature.split(/\s+/).filter(Boolean);
    if (parts.length > 1) add('full_name', 'Full name', signature, ['Name', 'Candidate name']);
    else add('preferred_name', 'Preferred first name', signature, ['First name', 'Given name']);
  }
  return records;
}

function emailTemplateRecords(body, source) {
  return [{
    key: 'email_template',
    question: 'Application email or cover letter',
    answer: body,
    aliases: ['Email body', 'Cover Letter', 'Covering Letter', 'Application message', 'Message'],
    type: 'email-template',
    status: 'draft',
    sensitivity: 'review',
    options: [],
    source,
  }, ...derivedEmailRecords(body, source)];
}

export function rowsToRecords(rows, source = 'google-sheet') {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const headers = rows[0].map((header) => String(header).trim());
  let columns = Object.fromEntries(
    Object.keys(HEADER_ALIASES).map((name) => [name, findColumn(headers, name)]),
  );
  let dataRows = rows.slice(1);

  const hasHeaders = columns.answer >= 0 && (columns.question >= 0 || columns.key >= 0);
  if (!hasHeaders) {
    const hasKeyValueRows = rows.some((cells) => String(cells[0] ?? '').trim() && String(cells[1] ?? '').trim());
    if (!hasKeyValueRows) {
      const body = rows.flat().map((cell) => String(cell ?? '').trim()).filter(Boolean).join('\n');
      if (body && /email|cover letter|message/i.test(source)) {
        return emailTemplateRecords(body, source);
      }
      return [];
    }
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

export function buildGoogleSheetCsvUrl(input) {
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

export function chooseRecord(field, records) {
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

export function shouldAutofill(record) {
  return normalizeText(record?.status) === 'verified'
    && normalizeText(record?.sensitivity || 'safe') === 'safe';
}
