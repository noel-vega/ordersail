import { strict as assert } from 'node:assert';
import { after, describe, it, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { metrics } from '@opentelemetry/api';
import type { PushMetricExporter } from '@opentelemetry/sdk-metrics';
import { captureLogs } from 'logging/test-helpers';
import { saveEnv } from 'test-support/env';
import { shutdownMetrics, startMetrics } from './index.ts';

// Export failures reach the logs through the diag logger packages/logging
// registers. The reader reports every export the same way, timed or flushed,
// so the interval is shortened and the specs wait for the line.
const ENV_KEYS = [
  'OTEL_METRIC_EXPORT_INTERVAL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_METRICS_EXPORTER',
] as const;
after(saveEnv(ENV_KEYS));
process.env.OTEL_METRIC_EXPORT_INTERVAL = '50';
delete process.env.OTEL_METRICS_EXPORTER;

const SECRET = 'c2VjcmV0LXRva2Vu';

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const byEvent = (lines: Record<string, any>[], event: string) => lines.filter((line) => line.event === event);
const tracingLines = (lines: Record<string, any>[]) => lines.filter((line) => String(line.event).startsWith('tracing.'));

describe('a failing metrics export', () => {
  it('a rejected token: a metrics.export_failed warn line, never a tracing one, and no credentials', async (t: TestContext) => {
    const authorization: (string | undefined)[] = [];
    const collector = createServer((req, res) => {
      authorization.push(req.headers.authorization);
      req.resume();
      req.on('end', () => {
        res.statusCode = 401;
        res.end('{"status":"error","error":"authentication error: invalid token"}');
      });
    });
    await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      await shutdownMetrics(0);
      await new Promise((resolve) => collector.close(resolve));
    });
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
    // the format Grafana Cloud's OTLP setup gives: the space percent-encoded
    process.env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=Basic%20${SECRET}`;

    const lines = captureLogs();
    assert.equal(startMetrics({ service: 'spec' }), true);
    metrics.getMeter('spec').createCounter('spec.requests').add(1);

    await waitFor(() => byEvent(lines, 'metrics.export_failed').length > 0);
    await shutdownMetrics(0);

    // the header reached the backend decoded
    assert.equal(authorization[0], `Basic ${SECRET}`);

    const [line] = byEvent(lines, 'metrics.export_failed');
    assert.equal(line.level, 'warn', 'the service is fine — only its metrics are lost');
    assert.equal(line.context, 'OpenTelemetry');
    assert.equal(line.msg, 'Metric export failed');
    assert.match(line.err.message, /metrics export failed.*Unauthorized/);
    assert.equal(byEvent(lines, 'tracing.export_failed').length, 0, 'a metrics failure must not send anyone after the trace token');
    assert.equal(JSON.stringify(lines).includes(SECRET), false);
  });

  it('a backend that never answers: a metrics.sdk_errored timeout line, never a tracing one', async (t: TestContext) => {
    // accepts the connection and never responds; the reader's timeout is
    // clamped to the 50ms interval, well inside the exporter's own
    const blackHole = createServer(() => undefined);
    await new Promise<void>((resolve) => blackHole.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      await shutdownMetrics(0);
      blackHole.closeAllConnections();
      await new Promise((resolve) => blackHole.close(resolve));
    });
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${(blackHole.address() as AddressInfo).port}`;
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;

    const lines = captureLogs();
    assert.equal(startMetrics({ service: 'spec' }), true);
    metrics.getMeter('spec').createCounter('spec.requests').add(1);

    await waitFor(() => byEvent(lines, 'metrics.sdk_errored').length > 0);
    await shutdownMetrics(0);

    const [line] = byEvent(lines, 'metrics.sdk_errored');
    assert.equal(line.level, 'warn');
    assert.match(line.msg, /^PeriodicExportingMetricReader: metrics export timed out/);
    assert.deepEqual(tracingLines(lines), []);
  });

  it('an exporter that throws: metrics.export_failed, never "Trace export failed"', async (t: TestContext) => {
    t.after(() => shutdownMetrics(0));
    // The reader logs a throw itself, then rethrows the exporter's own error to
    // the global error handler — unprefixed, so without packages/metrics
    // stepping in it would read as a trace export failure.
    const throwing: PushMetricExporter = {
      export: () => {
        throw new Error('serializer blew up');
      },
      forceFlush: async () => undefined,
      shutdown: async () => undefined,
    };

    const lines = captureLogs();
    assert.equal(startMetrics({ service: 'spec', exporter: throwing }), true);
    metrics.getMeter('spec').createCounter('spec.requests').add(1);

    await waitFor(() => byEvent(lines, 'metrics.export_failed').length > 0);
    await shutdownMetrics(0);

    const [line] = byEvent(lines, 'metrics.export_failed');
    assert.equal(line.msg, 'Metric export failed');
    assert.match(line.err.message, /metrics export failed.*serializer blew up/);
    assert.deepEqual(tracingLines(lines), []);
    assert.deepEqual(byEvent(lines, 'otel.sdk_errored'), []);
  });
});
