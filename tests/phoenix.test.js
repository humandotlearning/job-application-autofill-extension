import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhoenixFetch, createPhoenixTrace, flushPhoenixQueue, getPhoenixStatus, tracePhoenixEvent } from '../src/phoenix.js';

const url = 'https://api.fireworks.ai/inference/v1/chat/completions';
const options = { method: 'POST', headers: { Authorization: 'Bearer secret-key' }, body: JSON.stringify({model: 'test-model', messages: [{role: 'user', content: 'Test input'}], response_format: {json_schema: {name: 'answer_planner'}}}) };

test('Phoenix captures exact input/output, model, usage and session without consuming response or exporting headers', async () => {
  const output = {choices: [{message: {content: 'Test output'}}], usage: {prompt_tokens: 12, completion_tokens: 3, total_tokens: 15}};
  const calls = [];
  const traced = createPhoenixFetch('application-1', { enabled: async () => true, fetchImpl: async (endpoint, init) => {
    calls.push({endpoint, init});
    return endpoint === url ? Response.json(output) : Response.json({total_queued: 1}, {status: 202});
  }});
  assert.deepEqual(await (await traced(url, options)).json(), output);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init, options);
  assert.equal(calls[1].endpoint, 'http://127.0.0.1:6006/v1/projects/job-autofill/spans');
  assert.equal(JSON.stringify(calls[1]).includes('secret-key'), false);
  const span = JSON.parse(calls[1].init.body).data[0];
  assert.equal(span.name, 'answer_planner');
  assert.deepEqual(JSON.parse(span.attributes['input.value']), JSON.parse(options.body));
  assert.deepEqual(JSON.parse(span.attributes['output.value']), output);
  assert.equal(span.attributes['session.id'], 'application-1');
  assert.equal(span.attributes['llm.token_count.total'], 15);
  assert.equal(Number.isFinite(span.attributes['http.request.duration_ms']), true);
  assert.equal(span.status_code, 'OK');
});

test('TypeSafe and decision metrics carry provider attribution without credentials', async () => {
  const calls = [];
  await tracePhoenixEvent('saved_answer_match_result', {'llm.provider': 'typesafe', 'typesafe.cache_hits': 2}, 'run-1', {
    enabled: async () => true,
    fetchImpl: async (endpoint, init) => { calls.push({endpoint, init}); return Response.json({}, {status: 202}); },
  });
  const span = JSON.parse(calls[0].init.body).data[0];
  assert.equal(span.name, 'saved_answer_match_result');
  assert.equal(span.attributes['llm.provider'], 'typesafe');
  assert.equal(span.attributes['typesafe.cache_hits'], 2);
  assert.equal(span.attributes['session.id'], 'run-1');
  assert.equal(JSON.stringify(span).includes('Authorization'), false);
});

test('disabled tracing makes only the original request', async () => {
  let calls = 0;
  const traced = createPhoenixFetch('', {enabled: async () => false, fetchImpl: async () => { calls++; return new Response('ok'); }});
  assert.equal(await (await traced(url, options)).text(), 'ok');
  assert.equal(calls, 1);
});

test('collector failures preserve successful provider response', async () => {
  const traced = createPhoenixFetch('', {enabled: async () => true, fetchImpl: async endpoint => {
    if (endpoint !== url) throw new Error('collector offline');
    return new Response('raw malformed output');
  }});
  assert.equal(await (await traced(url, options)).text(), 'raw malformed output');
});

test('network failures retain original error and export an error span', async () => {
  const original = new Error('provider timeout');
  let span;
  const traced = createPhoenixFetch('', {enabled: async () => true, fetchImpl: async (endpoint, init) => {
    if (endpoint === url) throw original;
    span = JSON.parse(init.body).data[0];
    return Response.json({total_queued: 1});
  }});
  await assert.rejects(traced(url, options), error => error === original);
  assert.equal(span.status_code, 'ERROR');
  assert.equal(span.status_message, 'provider timeout');
});

test('HTTP errors retain raw response and error status', async () => {
  let span;
  const traced = createPhoenixFetch('', {enabled: async () => true, fetchImpl: async (endpoint, init) => {
    if (endpoint === url) return new Response('rate limited', {status: 429});
    span = JSON.parse(init.body).data[0];
    return Response.json({total_queued: 1});
  }});
  const response = await traced(url, options);
  assert.equal(response.status, 429);
  assert.equal(await response.text(), 'rate limited');
  assert.equal(span.status_code, 'ERROR');
  assert.equal(span.attributes['output.value'], 'rate limited');
});

test('JSON null remains visible for auditing an invalid provider response', async () => {
  let span;
  const traced = createPhoenixFetch('', {enabled: async () => true, fetchImpl: async (endpoint, init) => {
    if (endpoint === url) return new Response('null');
    span = JSON.parse(init.body).data[0];
    return Response.json({total_queued: 1});
  }});
  assert.equal(await (await traced(url, options)).json(), null);
  assert.equal(span.attributes['output.value'], 'null');
});

test('collector delay cannot invalidate a completed provider body when its deadline expires', async () => {
  const {createServer} = await import('node:http');
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end('{"answer":"completed"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  try {
    const traced = createPhoenixFetch('', {enabled: async () => true, fetchImpl: async (target, init) => {
      if (target === endpoint) return fetch(target, init);
      // Deterministically reproduce a provider deadline expiring during collector export.
      controller.abort();
      return Response.json({total_queued: 1});
    }});
    const response = await traced(endpoint, {...options, signal: controller.signal});
    assert.equal(controller.signal.aborted, true);
    assert.deepEqual(await response.json(), {answer: 'completed'});
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('child provider spans reuse the action trace and parent span', async () => {
  const calls = [];
  const traceContext = createPhoenixTrace('application-2', {'application.field_id': 'name'});
  const traced = createPhoenixFetch('application-2', {
    enabled: async () => true,
    traceContext,
    fetchImpl: async (endpoint, init) => {
      calls.push({endpoint, init});
      return endpoint === url ? Response.json({choices: [{message: {content: 'ok'}}]}) : Response.json({}, {status: 202});
    },
  });
  await (await traced(url, options)).json();
  const span = JSON.parse(calls[1].init.body).data[0];
  assert.equal(span.context.trace_id, traceContext.traceId);
  assert.equal(span.parent_id, traceContext.spanId);
  assert.equal(span.attributes['session.id'], 'application-2');
  assert.equal(span.attributes['application.field_id'], 'name');
});

test('Phoenix persists failed exports and retries them without changing span IDs', async () => {
  const data = {};
  globalThis.chrome = {
    runtime: {id: 'phoenix-test'},
    storage: {local: {
      get: async defaults => ({...defaults, ...data}),
      set: async values => Object.assign(data, values),
    }},
  };
  let attempts = 0;
  const traced = createPhoenixFetch('queued-session', {
    enabled: async () => true,
    fetchImpl: async (endpoint, init) => {
      if (endpoint === url) return Response.json({choices: [{message: {content: 'queued'}}]});
      attempts++;
      return attempts <= 1 ? new Response('offline', {status: 503}) : Response.json({total_queued: 1}, {status: 202});
    },
  });
  await (await traced(url, options)).json();
  let status = await getPhoenixStatus();
  assert.equal(status.pending, 1);
  const queuedId = data.phoenixTraceQueue[0].span.context.span_id;
  await flushPhoenixQueue({enabled: async () => true, fetchImpl: async (endpoint, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.data[0].context.span_id, queuedId);
    return Response.json({total_queued: 1}, {status: 202});
  }});
  await flushPhoenixQueue({enabled: async () => true, fetchImpl: async (endpoint, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.data[0].context.span_id, queuedId);
    return Response.json({total_queued: 1}, {status: 202});
  }});
  status = await getPhoenixStatus();
  assert.equal(status.pending, 0);
  delete globalThis.chrome;
});
