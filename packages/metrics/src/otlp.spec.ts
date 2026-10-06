import { strict as assert } from 'node:assert';
import { after, describe, it, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { metrics } from '@opentelemetry/api';
import { saveEnv } from 'test-support/env';
import { shutdownMetrics, startMetrics } from './index.ts';

const ENV_KEYS = ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_METRICS_EXPORTER'] as const;
after(saveEnv(ENV_KEYS));
delete process.env.OTEL_METRICS_EXPORTER;

describe('export over OTLP', () => {
  it('shutdownMetrics sends a final export to <endpoint>/v1/metrics', async () => {
    const received: { method?: string; url?: string; contentType?: string; bytes: number }[] = [];
    const collector = createServer((req, res) => {
      let bytes = 0;
      req.on('data', (chunk: Buffer) => (bytes += chunk.length));
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, contentType: req.headers['content-type'], bytes });
        res.end();
      });
    });
    await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;

    assert.equal(startMetrics({ service: 'spec' }), true);
    metrics.getMeter('spec').createCounter('spec.requests').add(3);
    assert.equal(received.length, 0, 'the 60s interval has not fired');

    await shutdownMetrics();
    await new Promise((resolve) => collector.close(resolve));

    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].url, '/v1/metrics');
    assert.equal(received[0].contentType, 'application/x-protobuf');
    assert.ok(received[0].bytes > 0);
  });

  it('shutdownMetrics gives up after its timeout when the backend does not answer', async (t: TestContext) => {
    // accepts the connection and never responds
    const blackHole = createServer(() => undefined);
    await new Promise<void>((resolve) => blackHole.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      await shutdownMetrics(0);
      blackHole.closeAllConnections();
      await new Promise((resolve) => blackHole.close(resolve));
    });
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${(blackHole.address() as AddressInfo).port}`;

    // the first test shut metrics down; starting again must give a live provider
    assert.equal(startMetrics({ service: 'spec' }), true);
    metrics.getMeter('spec').createCounter('spec.requests').add(1);

    const started = Date.now();
    await shutdownMetrics(200);
    const elapsed = Date.now() - started;
    // it waited on the export (so the timeout is what ended it) …
    assert.ok(elapsed >= 180, `returned after ${elapsed}ms — the export never ran`);
    // … and did not wait for the exporter's own, much longer timeout
    assert.ok(elapsed < 2000, `returned after ${elapsed}ms`);
  });
});
