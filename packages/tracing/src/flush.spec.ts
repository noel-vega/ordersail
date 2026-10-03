import { strict as assert } from 'node:assert';
import { describe, it, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { trace } from '@opentelemetry/api';
import { shutdownTracing, startTracing } from './index.ts';

describe('export over OTLP', () => {
  it('shutdownTracing sends the spans still in the batch to <endpoint>/v1/traces', async () => {
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

    assert.equal(startTracing({ service: 'spec' }), true);
    trace.getTracer('spec').startSpan('still in the batch').end();
    assert.equal(received.length, 0, 'the batch processor has not exported yet');

    await shutdownTracing();
    await new Promise((resolve) => collector.close(resolve));

    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].url, '/v1/traces');
    assert.equal(received[0].contentType, 'application/x-protobuf');
    assert.ok(received[0].bytes > 0);
  });

  it('shutdownTracing gives up after its timeout when the backend does not answer', async (t: TestContext) => {
    // accepts the connection and never responds
    const blackHole = createServer(() => undefined);
    await new Promise<void>((resolve) => blackHole.listen(0, '127.0.0.1', resolve));
    // runs even when an assertion fails, so a failure can't hang the run
    t.after(async () => {
      await shutdownTracing(0);
      blackHole.closeAllConnections();
      await new Promise((resolve) => blackHole.close(resolve));
    });
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${(blackHole.address() as AddressInfo).port}`;

    // the first test shut tracing down; starting again must give a live provider
    assert.equal(startTracing({ service: 'spec' }), true);
    const span = trace.getTracer('spec').startSpan('never delivered');
    assert.equal(span.isRecording(), true);
    span.end();

    const started = Date.now();
    await shutdownTracing(200);
    const elapsed = Date.now() - started;
    // it waited on the export (so the timeout is what ended it) …
    assert.ok(elapsed >= 180, `returned after ${elapsed}ms — the export never ran`);
    // … and did not wait for the exporter's own, much longer timeout
    assert.ok(elapsed < 2000, `returned after ${elapsed}ms`);
  });
});
