import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { trace } from '@opentelemetry/api';
import { flushTracing, shutdownTracing, startTracing } from './index.ts';

describe('tracing off', () => {
  it('does nothing when OTEL_EXPORTER_OTLP_ENDPOINT is unset or empty', async () => {
    for (const value of [undefined, '']) {
      if (value === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = value;

      assert.equal(startTracing({ service: 'spec', framework: 'fastify' }), false);
      // no provider registered: the API hands out spans that record nothing
      const span = trace.getTracer('spec').startSpan('not recorded');
      assert.equal(span.isRecording(), false);
      span.end();
    }
    // both are safe to call from a shutdown path regardless
    await flushTracing();
    await shutdownTracing();
  });
});
