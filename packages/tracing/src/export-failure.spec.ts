import { strict as assert } from 'node:assert';
import { describe, it, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { trace } from '@opentelemetry/api';
import { configureLogging } from 'logging';
import { shutdownTracing, startTracing } from './index.ts';

// Export failures reach the logs through the diag logger packages/logging
// registers. Only the batch processor's timed flush reports through it (an
// explicit flush rejects to its caller), so the delay is shortened rather than
// flushing by hand.
process.env.OTEL_BSP_SCHEDULE_DELAY = '20';

const SECRET = 'c2VjcmV0LXRva2Vu';

function captureLogs(): Record<string, any>[] {
  const lines: Record<string, any>[] = [];
  configureLogging({
    service: 'test',
    nodeEnv: 'production',
    destination: { write: (chunk: string) => void lines.push(JSON.parse(chunk)) },
  });
  return lines;
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const exportFailures = (lines: Record<string, any>[]) =>
  lines.filter((line) => line.event === 'tracing.export_failed');

describe('a failing export', () => {
  it('a rejected token: one warn line per failed batch, not per span, and no credentials', async (t: TestContext) => {
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
      await shutdownTracing(0);
      await new Promise((resolve) => collector.close(resolve));
    });
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
    // the format Grafana Cloud's OTLP setup gives: the space percent-encoded
    process.env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=Basic%20${SECRET}`;

    const lines = captureLogs();
    assert.equal(startTracing({ service: 'spec' }), true);
    const tracer = trace.getTracer('spec');
    for (let i = 0; i < 50; i++) tracer.startSpan(`request ${i}`).end();

    await waitFor(() => exportFailures(lines).length > 0);
    // a 401 is not retried: one request, one line
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(authorization.length, 1, '50 spans went out as one batch');
    assert.equal(exportFailures(lines).length, 1);

    // the header reached the backend decoded
    assert.equal(authorization[0], `Basic ${SECRET}`);

    const [line] = exportFailures(lines);
    assert.equal(line.level, 'warn', 'an error line would feed the error alarm');
    assert.equal(line.context, 'OpenTelemetry');
    assert.equal(line.msg, 'Trace export failed');
    assert.equal(line.err.message, 'Unauthorized');
    assert.equal(line.err.code, '401');
    assert.equal(JSON.stringify(lines).includes(SECRET), false);
  });

  it('an unreachable backend: still one line per batch, after the exporter gives up', async (t: TestContext) => {
    // a port nothing listens on
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise((resolve) => probe.close(resolve));
    t.after(() => shutdownTracing(0));
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${port}`;
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    // bounds the exporter's retries (5 attempts with backoff) to keep the spec short
    process.env.OTEL_EXPORTER_OTLP_TIMEOUT = '300';

    const lines = captureLogs();
    assert.equal(startTracing({ service: 'spec' }), true);
    const tracer = trace.getTracer('spec');
    for (let i = 0; i < 50; i++) tracer.startSpan(`request ${i}`).end();

    await waitFor(() => exportFailures(lines).length > 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(exportFailures(lines).length, 1);
    assert.equal(exportFailures(lines)[0].level, 'warn');
  });
});
