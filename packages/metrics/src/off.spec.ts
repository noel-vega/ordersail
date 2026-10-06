import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { metrics } from '@opentelemetry/api';
import { saveEnv } from 'test-support/env';
import { flushMetrics, shutdownMetrics, startMetrics } from './index.ts';

const ENV_KEYS = ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'OTEL_METRICS_EXPORTER'] as const;
after(saveEnv(ENV_KEYS));

describe('metrics off', () => {
  it('does nothing when no OTLP endpoint is set, or it is empty', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
    delete process.env.OTEL_METRICS_EXPORTER;
    for (const value of [undefined, '']) {
      if (value === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = value;

      assert.equal(startMetrics({ service: 'spec' }), false);
      // no provider registered: the API's meter is the no-op one
      assert.equal(metrics.getMeterProvider().constructor.name, 'NoopMeterProvider');
      metrics.getMeter('spec').createCounter('ignored').add(1);
    }
    // both are safe to call from a shutdown path regardless
    await flushMetrics();
    await shutdownMetrics();
  });

  it('OTEL_METRICS_EXPORTER=none keeps metrics off even with the shared endpoint set', () => {
    // production sets the endpoint for traces; metrics are switched on separately
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    process.env.OTEL_METRICS_EXPORTER = 'none';
    assert.equal(startMetrics({ service: 'spec' }), false);
    assert.equal(metrics.getMeterProvider().constructor.name, 'NoopMeterProvider');
  });
});
