import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ALLOWED_ATTRIBUTES, ALLOWED_EVENT_ATTRIBUTES, createInstrumentations } from './index.ts';

// Pins what a traced request records. If this fails, an instrumentation was
// added, removed or loosened — update it only as a deliberate decision
// (docs/observability.md → Tracing).
describe('pinned instrumentations', () => {
  const instrumentations = createInstrumentations();
  const byName = (name: string): any => {
    const found = instrumentations.find((instrumentation) => instrumentation.instrumentationName === name);
    assert.ok(found, `${name} is not in the list`);
    return found.getConfig();
  };

  it('is exactly HTTP, Fastify and pg', () => {
    assert.deepEqual(
      instrumentations.map((instrumentation) => instrumentation.instrumentationName),
      ['@opentelemetry/instrumentation-http', '@fastify/otel', '@opentelemetry/instrumentation-pg'],
    );
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

  it('exports only allow-listed span attributes', () => {
    assert.deepEqual([...ALLOWED_ATTRIBUTES].sort(), [
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
