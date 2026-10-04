import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SPAN_ATTRIBUTES } from 'logging/span-attributes';
import { ALLOWED_ATTRIBUTES, ALLOWED_EVENT_ATTRIBUTES, createInstrumentations } from './index.ts';

// Pins what a traced request records. If this fails, an instrumentation was
// added, removed or loosened — update it only as a deliberate decision
// (docs/observability.md → Tracing).
describe('pinned instrumentations', () => {
  const instrumentations = createInstrumentations('fastify');
  const byName = (name: string, list = instrumentations): any => {
    const found = list.find((instrumentation) => instrumentation.instrumentationName === name);
    assert.ok(found, `${name} is not in the list`);
    return found.getConfig();
  };

  it('fastify: exactly HTTP, Fastify and pg', () => {
    assert.deepEqual(
      instrumentations.map((instrumentation) => instrumentation.instrumentationName),
      ['@opentelemetry/instrumentation-http', '@fastify/otel', '@opentelemetry/instrumentation-pg'],
    );
  });

  it('express: exactly HTTP, Express and pg — the same HTTP and pg settings', () => {
    const express = createInstrumentations('express');
    assert.deepEqual(
      express.map((instrumentation) => instrumentation.instrumentationName),
      ['@opentelemetry/instrumentation-http', '@opentelemetry/instrumentation-express', '@opentelemetry/instrumentation-pg'],
    );
    for (const name of ['@opentelemetry/instrumentation-http', '@opentelemetry/instrumentation-pg']) {
      assert.deepEqual(
        JSON.stringify(byName(name, express)),
        JSON.stringify(byName(name)),
        `${name} is configured differently for Express`,
      );
    }
  });

  it('Express: no spans of its own — every layer type ignored, there only for the route', () => {
    const config = byName('@opentelemetry/instrumentation-express', createInstrumentations('express'));
    assert.deepEqual([...config.ignoreLayersType].sort(), ['middleware', 'request_handler', 'router']);
  });

  it('HTTP: skips /health and background outbound calls', () => {
    const config = byName('@opentelemetry/instrumentation-http');
    assert.equal(config.ignoreIncomingRequestHook({ url: '/health' }), true);
    assert.equal(config.ignoreIncomingRequestHook({ url: '/health?verbose=1' }), true);
    assert.equal(config.ignoreIncomingRequestHook({ url: '/healthy' }), false);
    assert.equal(config.ignoreIncomingRequestHook({ url: '/orders/1' }), false);
    assert.equal(config.requireParentforOutgoingSpans, true);
  });

  it('Fastify: request span only, /health skipped', () => {
    const config = byName('@fastify/otel');
    assert.equal(config.registerOnInitialization, true);
    assert.equal(config.instrumentHooks, false);
    assert.equal(config.instrumentHandler, false);
    assert.equal(config.ignorePaths({ url: '/health', method: 'GET' }), true);
    assert.equal(config.ignorePaths({ url: '/orders/:id', method: 'GET' }), false);
  });

  it('pg: no parentless spans, no parameter values', () => {
    const config = byName('@opentelemetry/instrumentation-pg');
    assert.equal(config.requireParentSpan, true);
    assert.equal(config.enhancedDatabaseReporting, false);
  });

  // the instrumentations' attributes; the log context's come from packages/logging
  it('exports only allow-listed span attributes', () => {
    const logContext = new Set(Object.values(SPAN_ATTRIBUTES));
    assert.deepEqual([...ALLOWED_ATTRIBUTES].filter((key) => !logContext.has(key)).sort(), [
      'db.collection.name',
      'db.namespace',
      'db.operation.name',
      'db.postgresql.idle.timeout.millis',
      'db.query.text',
      'db.response.status_code',
      'db.system.name',
      'error.type',
      'fastify.root',
      'http.request.method',
      'http.response.status_code',
      'http.route',
      'network.protocol.version',
      'server.address',
      'server.port',
      'url.scheme',
    ]);
  });

  // the log context widens the allow-list under its own namespace only — never
  // to an attribute an instrumentation records
  it('takes the log context packages/logging puts on a span, under ordersail.* only', () => {
    for (const key of Object.values(SPAN_ATTRIBUTES)) {
      assert.match(key, /^ordersail\.[a-z_]+$/);
    }
  });

  // this package loads logging/span-attributes before the instrumentations are
  // installed: anything it imported would load unpatched
  it('loads nothing through logging/span-attributes', () => {
    const built = readFileSync(fileURLToPath(import.meta.resolve('logging/span-attributes')), 'utf8');
    // a static import, a re-export, a dynamic import() or a require()
    assert.doesNotMatch(built, /^\s*import\b|^\s*export\b.*\bfrom\b|\bimport\(|\brequire\(/m);
  });

  it('keeps only type, message and stack on span events — what `err` keeps in logs', () => {
    assert.deepEqual([...ALLOWED_EVENT_ATTRIBUTES].sort(), [
      'exception.message',
      'exception.stacktrace',
      'exception.type',
    ]);
  });

  it('never allows the client, the raw URL or query parameter values', () => {
    for (const key of [
      'client.address',
      'network.peer.address',
      'user_agent.original',
      'url.full',
      'url.path',
      'url.query',
      'http.url',
      'http.target',
      'db.postgresql.values', // pg's parameter values, with enhancedDatabaseReporting
      'db.query.parameter.0',
    ]) {
      assert.equal(ALLOWED_ATTRIBUTES.has(key), false, key);
    }
  });
});
