import { strict as assert } from 'node:assert';
import { after, describe, it, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { metrics } from '@opentelemetry/api';
import { captureLogs } from 'logging/test-helpers';
import { shutdownMetrics, startMetrics } from './index.ts';

// Export failures reach the logs through the diag logger packages/logging
// registers. Only the reader's timed export reports through it (an explicit
// flush rejects to its caller), so the interval is shortened rather than
// flushing by hand.
const ENV_KEYS = [
  'OTEL_METRIC_EXPORT_INTERVAL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_METRICS_EXPORTER',
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});
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
});
