import { inferSensitivity, normalizeText } from './core.js';

const RESPONSE_URL = 'https://api.openai.com/v1/responses';
const MODEL = 'gpt-5.6-terra';
const MIN_OUTPUT_TOKENS = 512;
const TOKENS_PER_FIELD = 160;
const MAX_OUTPUT_TOKENS = 12_000;
const ACTIONS = new Set(['keep', 'fill', 'ask_user']);
const CONFIDENCE = new Set(['high', 'medium', 'low']);
const SENSITIVITY = new Set(['safe', 'review', 'legal']);

const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decisions'],
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['fieldId', 'action', 'value', 'evidenceKeys', 'confidence', 'sensitivity', 'reason'],
        properties: {
          fieldId: { type: 'string' },
          action: { type: 'string', enum: ['keep', 'fill', 'ask_user'] },
          value: { type: ['string', 'null'] },
          evidenceKeys: {
            type: 'array',
            items: { type: 'string' },
          },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          sensitivity: { type: 'string', enum: ['safe', 'review', 'legal'] },
          reason: { type: 'string' },
        },
      },
    },
  },
};

export async function callAnswerPlanner(
  { apiKey, fields = [], records = [], page = {} },
  { fetchImpl = fetch, timeoutMs = 10_000 } = {},
) {
  const normalizedApiKey = normalizeApiKey(apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Answer planner request timed out')), timeoutMs);

  try {
    const response = await fetchImpl(RESPONSE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${normalizedApiKey}`,
      },
      body: JSON.stringify(buildRequestBody({ fields, records, page })),
      signal: controller.signal,
    });

    if (!response.ok) {
      const details = await readErrorDetails(response);
      throw new Error(`Answer planner request failed (${response.status} ${response.statusText}): ${details}`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error(`Answer planner returned malformed JSON: ${error.message}`);
    }

    const parsed = extractStructuredOutput(payload);
    return { decisions: validateDecisions(parsed, fields, records) };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeApiKey(value) {
  const apiKey = String(value ?? '').trim();
  if (!/^[\x21-\x7E]+$/.test(apiKey)) {
    throw new Error('OpenAI API key contains unsupported characters. Paste the ASCII key exactly as issued.');
  }
  return apiKey;
}

function buildRequestBody({ fields, records, page }) {
  return {
    model: MODEL,
    reasoning: { effort: 'low' },
    store: false,
    max_output_tokens: outputTokenBudget(fields),
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: 'Plan autofill decisions using only supplied learned answer records. Return exactly one decision per supplied field. Transform an answer only when the records provide evidence. Never invent qualifications, dates, salary, authorization, sponsorship, identity, or any other fact. Use ask_user when evidence is missing, ambiguous, unsupported, or invalid. Never select controls or use selectors.',
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: JSON.stringify({
              page: sanitizePage(page),
              fields: fields.map(sanitizeField),
              records: records.map(sanitizeRecord),
            }),
          },
        ],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'answer_planner',
        strict: true,
        schema: DECISION_SCHEMA,
      },
    },
  };
}

function sanitizePage(page) {
  return {
    title: typeof page.title === 'string' ? page.title : '',
    domain: typeof page.domain === 'string' ? page.domain : '',
  };
}

function sanitizeField(field) {
  return {
    id: field.id,
    label: field.label ?? '',
    type: field.type ?? '',
    autocomplete: field.autocomplete ?? '',
    required: Boolean(field.required),
    currentValue: field.currentValue ?? '',
    options: Array.isArray(field.options) ? field.options.filter((option) => typeof option === 'string') : [],
    constraints: {
      min: field.constraints?.min,
      max: field.constraints?.max,
      minLength: field.constraints?.minLength,
      maxLength: field.constraints?.maxLength,
      pattern: field.constraints?.pattern,
    },
  };
}

function sanitizeRecord(record) {
  return {
    key: record.key,
    question: record.question ?? '',
    answer: record.answer ?? '',
    aliases: Array.isArray(record.aliases) ? record.aliases.filter((alias) => typeof alias === 'string') : [],
    type: record.type ?? '',
    sensitivity: record.sensitivity ?? '',
  };
}

function outputTokenBudget(fields = []) {
  return Math.min(MAX_OUTPUT_TOKENS, Math.max(MIN_OUTPUT_TOKENS, fields.length * TOKENS_PER_FIELD));
}

function extractStructuredOutput(payload) {
  const incompleteReason = payload?.incomplete_details?.reason || payload?.incompleteDetails?.reason;
  if (payload?.status === 'incomplete' || incompleteReason) {
    throw new Error(`Answer planner response was incomplete${incompleteReason ? ` (${incompleteReason})` : ''}.`);
  }

  const directText = typeof payload?.output_text === 'string' ? payload.output_text : '';
  const text = payload?.output
    ?.flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    ?.find((item) => item?.type === 'output_text' && typeof item.text === 'string')
    ?.text || directText;

  if (!text) {
    throw new Error('Answer planner response is missing structured output text');
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Answer planner returned invalid structured JSON: ${error.message}`);
  }
}

function validateDecisions(payload, fields, records) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.decisions)) {
    throw new Error('Answer planner response violates schema: decisions must be an array');
  }

  const fieldIds = new Set(fields.map((field) => field.id));
  const recordKeys = new Set(records.map((record) => record.key));
  if (payload.decisions.length !== fieldIds.size) {
    throw new Error('Answer planner response must contain exactly one decision for every field');
  }

  const seen = new Set();
  const decisions = payload.decisions.map((decision) => {
    const validated = validateDecision(decision, fieldIds, recordKeys, fields, records);
    if (seen.has(validated.fieldId)) {
      throw new Error(`Answer planner response contains a duplicate decision for field: ${validated.fieldId}`);
    }
    seen.add(validated.fieldId);
    return validated;
  });
  if (seen.size !== fieldIds.size) {
    throw new Error('Answer planner response is missing a decision for at least one field');
  }
  return decisions;
}

function comparableValue(field, value) {
  const text = String(value ?? '').trim();
  const type = normalizeText(field?.type);
  if (type === 'number' || type === 'range') return text.replace(/[\s,]/g, '');
  if (type === 'tel') return text.replace(/[^\d+]/g, '');
  if (type === 'url') {
    try {
      const url = new URL(text);
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '')}${url.search}${url.hash}`.toLowerCase();
    } catch {
      return normalizeText(text);
    }
  }
  return normalizeText(text);
}

function hasEvidenceForValue(field, value, evidenceKeys, records) {
  const expected = comparableValue(field, value);
  return records
    .filter((record) => evidenceKeys.includes(record.key))
    .some((record) => comparableValue(field, record.answer) === expected);
}

function validateDecision(decision, fieldIds, recordKeys, fields, records) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    throw new Error('Answer planner response violates schema: each decision must be an object');
  }

  const { fieldId, action, value, evidenceKeys, confidence, sensitivity, reason } = decision;

  if (typeof fieldId !== 'string' || !fieldIds.has(fieldId)) {
    throw new Error(`Answer planner response references unknown field id: ${String(fieldId)}`);
  }

  if (!ACTIONS.has(action)) {
    throw new Error(`Answer planner response uses invalid action: ${String(action)}`);
  }

  if (value !== null && typeof value !== 'string') {
    throw new Error('Answer planner response violates schema: value must be a string or null');
  }

  if (!Array.isArray(evidenceKeys) || evidenceKeys.some((key) => typeof key !== 'string')) {
    throw new Error('Answer planner response violates schema: evidenceKeys must be a string array');
  }

  for (const key of evidenceKeys) {
    if (!recordKeys.has(key)) {
      throw new Error(`Answer planner response references unknown evidence key: ${key}`);
    }
  }

  if (!CONFIDENCE.has(confidence)) {
    throw new Error(`Answer planner response uses invalid confidence: ${String(confidence)}`);
  }

  if (!SENSITIVITY.has(sensitivity)) {
    throw new Error(`Answer planner response uses invalid sensitivity: ${String(sensitivity)}`);
  }

  if (typeof reason !== 'string' || !reason.trim()) {
    throw new Error('Answer planner response violates schema: reason must be a non-empty string');
  }

  if (action === 'fill') {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error('Answer planner fill decisions require a non-empty value');
    }
    if (evidenceKeys.length === 0) {
      throw new Error('Answer planner fill decisions require at least one evidence key');
    }
    const field = fields.find((candidate) => candidate.id === fieldId);
    if (field && inferSensitivity(field.label, field.id) !== 'safe' && sensitivity === 'safe') {
      throw new Error(`Answer planner marked a sensitive field as safe: ${fieldId}`);
    }
    if (records.some((record) => evidenceKeys.includes(record.key) && ['review', 'legal'].includes(record.sensitivity)) && sensitivity === 'safe') {
      throw new Error(`Answer planner marked sensitive evidence as safe: ${fieldId}`);
    }
    if (!field || !hasEvidenceForValue(field, value, evidenceKeys, records)) {
      throw new Error(`Answer planner value is not an allowed transformation of its evidence: ${fieldId}`);
    }
  }

  return { fieldId, action, value, evidenceKeys, confidence, sensitivity, reason };
}

async function readErrorDetails(response) {
  try {
    const payload = await response.json();
    const message = payload?.error?.message;
    return typeof message === 'string' && message.trim() ? message : 'Request failed';
  } catch {
    return 'Request failed';
  }
}
