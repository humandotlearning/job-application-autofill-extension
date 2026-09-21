const BASE_URL = 'http://127.0.0.1:6006';
const PROJECT = 'job-autofill';

async function tracingEnabled() {
  // Only active in the extension unless explicitly enabled by a caller.
  if (!globalThis.chrome?.runtime?.id) return false;
  try {
    return (await chrome.storage.local.get({ phoenixTracing: true })).phoenixTracing;
  } catch { return false; }
}

/** Trace provider HTTP calls; buffer their body before the independent collector upload. */
export function createPhoenixFetch(sessionId = '', { fetchImpl = globalThis.fetch, enabled = tracingEnabled } = {}) {
  return async (url, options) => {
    let capture = false;
    try { capture = await enabled(); } catch { /* tracing cannot block AI */ }
    if (!capture) return fetchImpl(url, options);
    const startedAt = Date.now();
    const started = new Date(startedAt).toISOString();
    let response;
    let failure;
    try {
      response = await fetchImpl(url, options);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        const input = JSON.parse(options.body);
        let output = '';
        if (response) {
          try {
            output = await response.clone().text();
            // Provider deadlines may fire during export. A completed body must stay readable.
            if (response.body !== null) response = new Response(output, {
              status: response.status, statusText: response.statusText, headers: response.headers,
            });
          }
          catch (error) { failure ||= error; }
        }
        let parsed = {};
        try { parsed = JSON.parse(output); } catch { /* retain malformed raw output */ }
        const isTypeSafe = new URL(url).hostname === 'api.typesafe.ai';
        const step = isTypeSafe ? 'saved_answer_match' : input.text?.format?.name || input.response_format?.json_schema?.name || 'ai_request';
        const attributes = {
          'openinference.span.kind': 'LLM',
          'input.value': JSON.stringify(input), 'input.mime_type': 'application/json',
          'output.value': output, 'output.mime_type': 'application/json',
          'llm.model_name': input.model || '',
          'llm.provider': isTypeSafe ? 'typesafe' : new URL(url).hostname.includes('fireworks') ? 'fireworks' : 'openai',
          'http.response.status_code': response?.status || 0,
          'http.request.duration_ms': Date.now() - startedAt,
        };
        if (sessionId) attributes['session.id'] = sessionId;
        for (const [key, value] of Object.entries({
          prompt: parsed?.usage?.prompt_tokens ?? parsed?.usage?.input_tokens,
          completion: parsed?.usage?.completion_tokens ?? parsed?.usage?.output_tokens,
          total: parsed?.usage?.total_tokens,
        })) if (Number.isFinite(value)) attributes[`llm.token_count.${key}`] = value;
        const span = {
          name: step, span_kind: 'LLM',
          context: { trace_id: crypto.randomUUID().replaceAll('-', ''), span_id: crypto.randomUUID().replaceAll('-', '').slice(0, 16) },
          start_time: started, end_time: new Date().toISOString(),
          status_code: failure || !response?.ok ? 'ERROR' : 'OK',
          status_message: failure ? String(failure.message) : response?.ok ? '' : `HTTP ${response?.status}`,
          attributes,
        };
        // Bound export latency. No provider headers or API keys are copied to Phoenix.
        const exported = await fetchImpl(`${BASE_URL}/v1/projects/${PROJECT}/spans`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: [span] }), signal: AbortSignal.timeout(750),
        });
        if (!exported.ok) throw new Error(`HTTP ${exported.status}`);
      } catch (error) {
        console.warn('Phoenix trace not saved. Start local Phoenix or disable tracing in Settings.', error.message);
      }
    }
    return response;
  };
}

/** Record bounded decision metrics without copying answer text or provider credentials. */
export async function tracePhoenixEvent(name, attributes = {}, sessionId = '', {
  fetchImpl = globalThis.fetch, enabled = tracingEnabled,
} = {}) {
  try {
    if (!(await enabled())) return;
    const now = new Date().toISOString();
    const spanAttributes = {'openinference.span.kind': 'CHAIN', ...attributes};
    if (sessionId) spanAttributes['session.id'] = sessionId;
    const span = {
      name, span_kind: 'CHAIN',
      context: {trace_id: crypto.randomUUID().replaceAll('-', ''), span_id: crypto.randomUUID().replaceAll('-', '').slice(0, 16)},
      start_time: now, end_time: now, status_code: 'OK', status_message: '', attributes: spanAttributes,
    };
    const response = await fetchImpl(`${BASE_URL}/v1/projects/${PROJECT}/spans`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({data: [span]}),
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    console.warn('Phoenix decision trace not saved. Start local Phoenix or disable tracing in Settings.', error.message);
  }
}
