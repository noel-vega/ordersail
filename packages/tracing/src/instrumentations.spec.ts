import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createInstrumentations, SCRUBBED_ATTRIBUTES } from './index.ts';

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

  it('scrubs every raw-URL attribute, old and new semantic conventions', () => {
    assert.deepEqual([...SCRUBBED_ATTRIBUTES].sort(), ['http.target', 'http.url', 'url.full', 'url.path', 'url.query']);
  });
});
