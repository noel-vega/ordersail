import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { SpanKind } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { flushTracing, shutdownTracing, startTracing } from './index.ts';

// Its own file: node --test runs each file in its own process, so the Express
// instrumentation registered here never meets the Fastify specs.
const exporter = new InMemorySpanExporter();
assert.equal(startTracing({ service: 'spec', framework: 'express', exporter }), true);
// required after startTracing, the way a service loads them after ./instrument
const require = createRequire(import.meta.url);
const express: typeof import('express') = require('express');
const http: typeof import('node:http') = require('node:http');

const get = (url: string) =>
  new Promise<number>((resolve, reject) => {
    http
      .get(url, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      })
      .on('error', reject);
  });

after(() => shutdownTracing());

// The shape Nest's Express adapter builds: global middleware, then a route
describe('what a traced Express request records', () => {
  let server: import('node:http').Server;
  let base: string;

  before(async () => {
    const app = express();
    app.use((_req, _res, next) => next()); // stands in for helmet, cors, the request logger…
    app.use(express.json());
    app.get('/health', (_req, res) => void res.send('ok'));
    app.get('/orders/:id', (_req, res) => void res.send('ok'));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  it('one span: the HTTP server span, named after the route template', async () => {
    exporter.reset();
    assert.equal(await get(`${base}/orders/ord_SECRET?x=1`), 200);
    await flushTracing();

    const spans = exporter.getFinishedSpans();
    assert.deepEqual(
      spans.map((span) => [span.name, span.kind]),
      [['GET /orders/:id', SpanKind.SERVER]],
      'no middleware, router or request-handler spans',
    );
    assert.equal(spans[0].attributes['http.route'], '/orders/:id');
    assert.equal(JSON.stringify(spans[0].attributes).includes('ord_SECRET'), false);
  });

  it('/health records nothing', async () => {
    exporter.reset();
    assert.equal(await get(`${base}/health`), 200);
    await flushTracing();
    assert.deepEqual(exporter.getFinishedSpans(), []);
  });
});
