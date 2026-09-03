const RESPONSE_URL = 'https://api.openai.com/v1/responses';
const MODEL = 'gpt-5.6-terra';
const MAX_OUTPUT_TOKENS = 250;
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Answer planner request timed out')), timeoutMs);

  try {
    const response = await fetchImpl(RESPONSE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
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

function buildRequestBody({ fields, records, page }) {
  return {
    model: MODEL,
    reasoning: { effort: 'low' },
    store: false,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: 'Plan autofill decisions using only supplied records. Return one decision per field.',
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_json',
            input_json: {
              page: sanitizePage(page),
              fields: fields.map(sanitizeField),
              records: records.map(sanitizeRecord),
            },
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
    required: Boolean(field.required),
    options: Array.isArray(field.options) ? field.options.filter((option) => typeof option === 'string') : [],
  };
}

function sanitizeRecord(record) {
  return {
    key: record.key,
    question: record.question ?? '',
    answer: record.answer ?? '',
    aliases: Array.isArray(record.aliases) ? record.aliases.filter((alias) => typeof alias === 'string') : [],
    type: record.type ?? '',
    status: record.status ?? '',
    sensitivity: record.sensitivity ?? '',
    source: record.source ?? '',
  };
}

function extractStructuredOutput(payload) {
  const text = payload?.output
    ?.flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    ?.find((item) => item?.type === 'output_text' && typeof item.text === 'string')
    ?.text;

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

  return payload.decisions.map((decision) => validateDecision(decision, fieldIds, recordKeys));
}

function validateDecision(decision, fieldIds, recordKeys) {
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
