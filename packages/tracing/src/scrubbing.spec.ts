import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { context, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { ALLOWED_ATTRIBUTES, flushTracing, ScrubbingSpanExporter, shutdownTracing, startTracing } from './index.ts';

const exporter = new InMemorySpanExporter();
assert.equal(startTracing({ service: 'spec', framework: 'fastify', exporter }), true);
// required after startTracing, the way a service loads them after ./instrument
const require = createRequire(import.meta.url);
const http: typeof import('node:http') = require('node:http');
const Fastify: typeof import('fastify').default = require('fastify');

const SECRETS = ['PATHSECRET', 'QUERYSECRET', 'secret-agent/1.0'];

function assertClean(spans: ReadableSpan[]) {
  const text = JSON.stringify(spans.map((span) => [span.name, span.attributes]));
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `${secret} leaked: ${text}`);
  for (const span of spans) {
    for (const key of Object.keys(span.attributes)) {
      assert.ok(ALLOWED_ATTRIBUTES.has(key), `${span.name} exported ${key}`);
    }
  }
}

const get = (url: string) =>
  new Promise<number>((resolve, reject) => {
    http
      .get(url, { headers: { 'user-agent': 'secret-agent/1.0' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      })
      .on('error', reject);
  });

after(() => shutdownTracing());

describe('what a traced plain HTTP request records', () => {
  let server: import('node:http').Server;
  let base: string;

  before(async () => {
    server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  it('keeps the method and status; drops the raw path, query, client IP and user agent', async () => {
    exporter.reset();
    // inside a parent span, so the outbound (client) span is recorded too
    const parent = trace.getTracer('spec').startSpan('parent');
    await context.with(trace.setSpan(context.active(), parent), () =>
      get(`${base}/invites/tok_PATHSECRET?token=QUERYSECRET`),
    );
    parent.end();
    await flushTracing();

    const httpSpans = exporter.getFinishedSpans().filter((span) => span.attributes['http.request.method']);
    assert.equal(httpSpans.length, 2, 'expected the server span and the client span');
    for (const span of httpSpans) assert.equal(span.attributes['http.response.status_code'], 200);
    assertClean(exporter.getFinishedSpans());
  });

  it('records nothing for /health, or for an outbound call with no parent', async () => {
    exporter.reset();
    await get(`${base}/health`);
    await get(`${base}/health?verbose=1`);
    await flushTracing();
    assert.deepEqual(exporter.getFinishedSpans().map((span) => span.name), []);
  });
});

describe('what a traced Fastify request records', () => {
  const app = Fastify();
  let base: string;

  before(async () => {
    // a hook like merchant-api's cookie / CORS / helmet ones — it must not get a span
    app.addHook('onRequest', async () => undefined);
    app.get('/invites/:token', async () => 'ok');
    app.get('/health', async () => 'ok');
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  after(() => app.close());

  it('names the spans by route template and exports no raw path, query, client IP or user agent', async () => {
    exporter.reset();
    assert.equal(await get(`${base}/invites/tok_PATHSECRET?token=QUERYSECRET`), 200);
    await flushTracing();

    const spans = exporter.getFinishedSpans();
    const server = spans.find((span) => span.instrumentationScope.name === '@opentelemetry/instrumentation-http');
    const request = spans.find((span) => span.instrumentationScope.name === '@fastify/otel');
    assert.equal(server?.name, 'GET /invites/:token');
    assert.equal(request?.attributes['http.route'], '/invites/:token');
    assert.equal(request?.parentSpanContext?.spanId, server?.spanContext().spanId);
    // only the request span: no per-hook or handler spans
    assert.equal(spans.filter((span) => span.instrumentationScope.name === '@fastify/otel').length, 1);
    assertClean(spans);
  });

  it('records nothing for /health', async () => {
    exporter.reset();
    assert.equal(await get(`${base}/health`), 200);
    await flushTracing();
    assert.deepEqual(exporter.getFinishedSpans().map((span) => span.name), []);
  });
});

describe('what a span event or link records', () => {
  it('keeps a recorded exception as logs keep `err`; drops any other event or link attribute', async () => {
    exporter.reset();
    const tracer = trace.getTracer('spec');
    const linked = tracer.startSpan('linked');
    linked.end();
    const span = tracer.startSpan('op', {
      links: [{ context: linked.spanContext(), attributes: { 'url.full': 'https://x/?token=QUERYSECRET' } }],
    });
    span.recordException(new Error('signin failed'));
    span.addEvent('retry', { 'user_agent.original': 'secret-agent/1.0', 'url.path': '/invites/tok_PATHSECRET' });
    span.end();
    await flushTracing();

    const exported = exporter.getFinishedSpans().find((s) => s.name === 'op');
    assert.ok(exported);
    const [exception, retry] = exported.events;
    assert.equal(exception.name, 'exception');
    assert.equal(exception.attributes?.['exception.type'], 'Error');
    assert.equal(exception.attributes?.['exception.message'], 'signin failed');
    assert.ok(exception.attributes?.['exception.stacktrace']);
    assert.equal(retry.name, 'retry');
    assert.deepEqual(retry.attributes, {});
    assert.equal(retry.droppedAttributesCount, 2);
    assert.deepEqual(exported.links[0].attributes, {});
    assert.equal(exported.links[0].context.spanId, linked.spanContext().spanId);

    const text = JSON.stringify([exported.events, exported.links]);
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `${secret} leaked: ${text}`);
  });
});

describe('ScrubbingSpanExporter', () => {
  it('keeps allow-listed attributes, drops the rest, leaves the span otherwise readable', () => {
    const inner = new InMemorySpanExporter();
    const span = {
      name: 'GET /orders/:id',
      attributes: {
        'http.route': '/orders/:id',
        'http.response.status_code': 200,
        'url.full': 'https://api.example.com/orders/1?token=abc',
        'url.path': '/orders/1',
        'client.address': '203.0.113.7',
        'user_agent.original': 'Mozilla/5.0',
        'some.future.attribute': 'x',
      },
      droppedAttributesCount: 0,
      events: [],
      links: [],
      spanContext: () => ({ traceId: 't', spanId: 's', traceFlags: 1 }),
    } as unknown as ReadableSpan;

    new ScrubbingSpanExporter(inner).export([span], () => undefined);

    const [exported] = inner.getFinishedSpans();
    assert.deepEqual(exported.attributes, { 'http.route': '/orders/:id', 'http.response.status_code': 200 });
    assert.equal(exported.name, 'GET /orders/:id');
    assert.equal(exported.spanContext().spanId, 's');
    assert.equal(exported.droppedAttributesCount, 5);
    // the original span is not mutated
    assert.equal(span.attributes['url.path'], '/orders/1');
  });
});
