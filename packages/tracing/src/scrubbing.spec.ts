import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { context, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { flushTracing, ScrubbingSpanExporter, shutdownTracing, startTracing } from './index.ts';

const exporter = new InMemorySpanExporter();
assert.equal(startTracing({ service: 'spec', exporter }), true);
// required after startTracing, the way a service loads it after ./instrument
const http: typeof import('node:http') = createRequire(import.meta.url)('node:http');

const attributeText = (spans: ReadableSpan[]) => JSON.stringify(spans.map((span) => [span.name, span.attributes]));

describe('what a traced HTTP request records', () => {
  let server: import('node:http').Server;
  let base: string;

  before(async () => {
    server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await shutdownTracing();
  });

  const get = (path: string) =>
    new Promise<void>((resolve, reject) => {
      http
        .get(`${base}${path}`, (res) => {
          res.resume();
          res.on('end', () => resolve());
        })
        .on('error', reject);
    });

  it('keeps the method and status, drops the raw path and query string', async () => {
    exporter.reset();
    // inside a parent span, so the outbound (client) span is recorded too
    const parent = trace.getTracer('spec').startSpan('parent');
    await context.with(trace.setSpan(context.active(), parent), () => get('/invites/tok_PATHSECRET?token=QUERYSECRET'));
    parent.end();
    await flushTracing();

    const spans = exporter.getFinishedSpans();
    const kinds = spans.map((span) => span.attributes['http.request.method'] && span.kind).filter((kind) => kind !== undefined);
    assert.equal(kinds.length, 2, 'expected the server span and the client span');
    for (const span of spans.filter((candidate) => candidate.attributes['http.request.method'])) {
      assert.equal(span.attributes['http.request.method'], 'GET');
      assert.equal(span.attributes['http.response.status_code'], 200);
    }
    const text = attributeText(spans);
    assert.ok(!text.includes('QUERYSECRET'), text);
    assert.ok(!text.includes('PATHSECRET'), text);
  });

  it('records nothing for /health, or for an outbound call with no parent', async () => {
    exporter.reset();
    await get('/health');
    await get('/health?verbose=1');
    await flushTracing();
    assert.deepEqual(
      exporter.getFinishedSpans().map((span) => span.name),
      [],
    );
  });
});

describe('ScrubbingSpanExporter', () => {
  it('removes the raw-URL attributes and leaves the rest of the span readable', () => {
    const inner = new InMemorySpanExporter();
    const span = {
      name: 'GET /orders/:id',
      attributes: {
        'http.route': '/orders/:id',
        'url.full': 'https://api.example.com/orders/1?token=abc',
        'url.path': '/orders/1',
        'url.query': 'token=abc',
        'http.url': 'https://api.example.com/orders/1?token=abc',
        'http.target': '/orders/1?token=abc',
      },
      spanContext: () => ({ traceId: 't', spanId: 's', traceFlags: 1 }),
    } as unknown as ReadableSpan;

    new ScrubbingSpanExporter(inner).export([span], () => undefined);

    const [exported] = inner.getFinishedSpans();
    assert.deepEqual(exported.attributes, { 'http.route': '/orders/:id' });
    assert.equal(exported.name, 'GET /orders/:id');
    assert.equal(exported.spanContext().spanId, 's');
    // the original span is not mutated
    assert.equal(span.attributes['url.path'], '/orders/1');
  });
});
