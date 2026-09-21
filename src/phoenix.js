const BASE_URL = 'http://127.0.0.1:6006';
const PROJECT = 'job-autofill';
const QUEUE_KEY = 'phoenixTraceQueue';
const STATUS_KEY = 'phoenixTraceStatus';
const MAX_QUEUE_ITEMS = 100;
const MAX_QUEUE_BYTES = 4 * 1024 * 1024;
const MAX_QUEUE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
let flushPromise = null;
let queueWritePromise = Promise.resolve();

function storageAvailable() { return Boolean(globalThis.chrome?.storage?.local?.get && globalThis.chrome?.storage?.local?.set); }
function id() { return crypto.randomUUID().replaceAll('-', ''); }
async function tracingEnabled() {
  if (!globalThis.chrome?.runtime?.id) return false;
  try { return (await chrome.storage.local.get({phoenixTracing: true})).phoenixTracing !== false; } catch { return false; }
}

export function createPhoenixTrace(sessionId = '', attributes = {}) {
  return {
    traceId: id(),
    spanId: id().slice(0, 16),
    sessionId: String(sessionId || ''),
    startedAt: new Date().toISOString(),
    attributes: {...attributes},
  };
}
function contextFor(options = {}, sessionId = '') {
  const context = options.traceContext || createPhoenixTrace(sessionId);
  return {...context, traceId: context.traceId || id(), spanId: context.spanId || id().slice(0, 16)};
}
async function readQueue() {
  if (!storageAvailable()) return [];
  const value = await chrome.storage.local.get({[QUEUE_KEY]: []});
  return Array.isArray(value[QUEUE_KEY]) ? value[QUEUE_KEY] : [];
}
async function writeQueue(queue) { if (storageAvailable()) await chrome.storage.local.set({[QUEUE_KEY]: queue}); }
async function getStoredStatus() { try { return (await chrome.storage.local.get({[STATUS_KEY]: {}}))[STATUS_KEY] || {}; } catch { return {}; } }
async function updateStatus(patch) { if (storageAvailable()) { try { await chrome.storage.local.set({[STATUS_KEY]: {...await getStoredStatus(), ...patch}}); } catch { /* best effort */ } } }
function queueBytes(queue) { return new TextEncoder().encode(JSON.stringify(queue)).byteLength; }
function spanKey(span) { return span?.context?.span_id || ''; }
async function enqueue(span) {
  const operation = queueWritePromise.then(async () => {
    const queue = (await readQueue()).filter(item => item?.expiresAt > Date.now() && item.span);
    queue.push({span, queuedAt: Date.now(), expiresAt: Date.now() + MAX_QUEUE_AGE_MS});
    let dropped = 0;
    while (queue.length > MAX_QUEUE_ITEMS || queueBytes(queue) > MAX_QUEUE_BYTES) { queue.shift(); dropped++; }
    await writeQueue(queue);
    const status = await getStoredStatus();
    await updateStatus({pending: queue.length, dropped: Number(status.dropped || 0) + dropped});
  });
  queueWritePromise = operation.catch(error => {
    void updateStatus({lastError: `Phoenix storage error: ${String(error?.message || error)}`});
  });
  return operation;
}
async function postSpanBatch(spans, fetchImpl) {
  const response = await fetchImpl(`${BASE_URL}/v1/projects/${PROJECT}/spans`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({data: spans}), signal: AbortSignal.timeout(750)});
  if (response.ok) return {delivered: true};
  let detail = ''; try { detail = await response.clone().text(); } catch { /* status is enough */ }
  if (response.status === 400 && /duplicate/i.test(detail)) return {delivered: true, duplicate: true};
  return {delivered: false, error: `HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`};
}
export async function getPhoenixStatus() {
  if (!storageAvailable()) return {pending: 0, dropped: 0, lastSuccessAt: '', lastError: ''};
  try { const [queue, status] = await Promise.all([readQueue(), getStoredStatus()]); return {pending: queue.length, dropped: Number(status.dropped || 0), lastSuccessAt: status.lastSuccessAt || '', lastError: status.lastError || ''}; } catch (error) { return {pending: 0, dropped: 0, lastSuccessAt: '', lastError: `Phoenix storage error: ${String(error?.message || error)}`}; }
}
export async function flushPhoenixQueue({fetchImpl = globalThis.fetch, enabled = tracingEnabled} = {}) {
  if (!storageAvailable()) return {pending: 0};
  if (flushPromise) {
    const running = flushPromise;
    await running;
    if (flushPromise === running) return flushPhoenixQueue({fetchImpl, enabled});
    return getPhoenixStatus();
  }
  flushPromise = (async () => {
    if (!(await enabled())) return getPhoenixStatus();
    const queue = (await readQueue()).filter(item => item?.expiresAt > Date.now() && item.span);
    if (!queue.length) {
      const operation = queueWritePromise.then(async () => {
        const current = (await readQueue()).filter(item => item?.expiresAt > Date.now() && item.span);
        await writeQueue(current);
        await updateStatus({pending: current.length});
      });
      queueWritePromise = operation.catch(error => { void updateStatus({lastError: `Phoenix storage error: ${String(error?.message || error)}`}); });
      await operation;
      return getPhoenixStatus();
    }
    const result = await postSpanBatch(queue.map(item => item.span), fetchImpl).catch(error => ({delivered: false, error: error.message}));
    if (result.delivered) {
      const delivered = new Set(queue.map(item => spanKey(item.span)).filter(Boolean));
      const operation = queueWritePromise.then(async () => {
        const current = (await readQueue()).filter(item => item?.expiresAt > Date.now() && item.span);
        const remaining = current.filter(item => !delivered.has(spanKey(item.span)));
        await writeQueue(remaining);
        await updateStatus({pending: remaining.length, lastSuccessAt: new Date().toISOString(), lastError: ''});
      });
      queueWritePromise = operation.catch(error => { void updateStatus({lastError: `Phoenix storage error: ${String(error?.message || error)}`}); });
      await operation;
    } else {
      const current = (await readQueue()).filter(item => item?.expiresAt > Date.now() && item.span);
      await updateStatus({pending: current.length, lastError: result.error});
    }
    return getPhoenixStatus();
  })().finally(() => { flushPromise = null; });
  return flushPromise;
}
async function saveSpan(span, {fetchImpl = globalThis.fetch} = {}) {
  if (storageAvailable()) { await enqueue(span); void flushPhoenixQueue({fetchImpl}).catch(error => updateStatus({lastError: String(error?.message || error)})); return; }
  const result = await postSpanBatch([span], fetchImpl);
  if (!result.delivered) throw new Error(result.error);
}

export function createPhoenixFetch(sessionId = '', {fetchImpl = globalThis.fetch, enabled = tracingEnabled, traceContext = null} = {}) {
  return async (url, options = {}) => {
    let capture = false; try { capture = await enabled(); } catch { /* tracing cannot block AI */ }
    if (!capture) return fetchImpl(url, options);
    const startedAt = Date.now(); const started = new Date(startedAt).toISOString(); let response; let failure;
    try { response = await fetchImpl(url, options); } catch (error) { failure = error; throw error; }
    finally {
      try {
        const input = JSON.parse(options.body || '{}'); let output = '';
        if (response) { try { output = await response.clone().text(); if (response.body !== null) response = new Response(output, {status: response.status, statusText: response.statusText, headers: response.headers}); } catch (error) { failure ||= error; } }
        let parsed = {}; try { parsed = JSON.parse(output); } catch { /* raw output remains visible */ }
        const providerUrl = new URL(url); const isTypeSafe = providerUrl.hostname === 'api.typesafe.ai';
        const step = isTypeSafe ? 'saved_answer_match' : input.text?.format?.name || input.response_format?.json_schema?.name || 'ai_request';
        const context = contextFor({traceContext}, sessionId);
        const attributes = {'openinference.span.kind': 'LLM', 'input.value': JSON.stringify(input), 'input.mime_type': 'application/json', 'output.value': output, 'output.mime_type': 'application/json', 'llm.model_name': input.model || '', 'llm.provider': isTypeSafe ? 'typesafe' : providerUrl.hostname.includes('fireworks') ? 'fireworks' : 'openai', 'http.response.status_code': response?.status || 0, 'http.request.duration_ms': Date.now() - startedAt, ...context.attributes};
        if (context.sessionId) attributes['session.id'] = context.sessionId;
        for (const [key, value] of Object.entries({prompt: parsed?.usage?.prompt_tokens ?? parsed?.usage?.input_tokens, completion: parsed?.usage?.completion_tokens ?? parsed?.usage?.output_tokens, total: parsed?.usage?.total_tokens})) if (Number.isFinite(value)) attributes[`llm.token_count.${key}`] = value;
        await saveSpan({name: step, span_kind: 'LLM', context: {trace_id: context.traceId, span_id: id()}, parent_id: context.spanId || undefined, start_time: started, end_time: new Date().toISOString(), status_code: failure || !response?.ok ? 'ERROR' : 'OK', status_message: failure ? String(failure.message) : response?.ok ? '' : `HTTP ${response?.status}`, attributes}, {fetchImpl});
      } catch (error) { console.warn('Phoenix trace queued but not delivered. Start local Phoenix or check Settings.', error.message); }
    }
    return response;
  };
}

export async function tracePhoenixEvent(name, attributes = {}, sessionId = '', {fetchImpl = globalThis.fetch, enabled = tracingEnabled, traceContext = null, root = false, defer = false, statusCode = 'OK', statusMessage = '', input = undefined, output = undefined} = {}) {
  const context = contextFor({traceContext}, sessionId);
  if (root && defer) {
    const target = traceContext || context;
    target.rootName = name;
    target.rootInput = input;
    target.rootAttributes = {...attributes};
    return target;
  }
  try {
    if (!(await enabled())) return context;
    const spanAttributes = {'openinference.span.kind': 'CHAIN', ...context.attributes, ...(root ? context.rootAttributes : {}), ...attributes};
    if (context.sessionId) spanAttributes['session.id'] = context.sessionId;
    if (root && input === undefined) input = context.rootInput;
    if (input !== undefined) { spanAttributes['input.value'] = typeof input === 'string' ? input : JSON.stringify(input); spanAttributes['input.mime_type'] = 'application/json'; }
    if (output !== undefined) { spanAttributes['output.value'] = typeof output === 'string' ? output : JSON.stringify(output); spanAttributes['output.mime_type'] = 'application/json'; }
    await saveSpan({name: root && context.rootName || name, span_kind: 'CHAIN', context: {trace_id: context.traceId, span_id: root || !traceContext ? context.spanId : id().slice(0, 16)}, ...(root || !traceContext ? {} : {parent_id: context.spanId}), start_time: root ? context.startedAt || new Date().toISOString() : new Date().toISOString(), end_time: new Date().toISOString(), status_code: statusCode, status_message: statusMessage, attributes: spanAttributes}, {fetchImpl});
  } catch (error) { console.warn('Phoenix action trace queued but not delivered.', error.message); }
  return context;
}
export const phoenixLimits = {MAX_QUEUE_ITEMS, MAX_QUEUE_BYTES, MAX_QUEUE_AGE_MS};
