import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { context, SpanKind, trace, TraceFlags } from '@opentelemetry/api';
import { RPCType, setRPCMetadata } from '@opentelemetry/core';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Logger, requestLoggingMiddleware, runWithLogContext, setLogContext } from './index.ts';
import { captureLogs } from './test-helpers.ts';

// Its own file: node --test runs each file in its own process, so the SDK
// registered here never reaches index.spec.ts, which covers the no-SDK case.
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();
after(() => provider.shutdown());

const tracer = trace.getTracer('spec');

describe('trace_id / span_id on log lines', () => {
  it('a line written inside a span carries its IDs', () => {
    const lines = captureLogs();
    tracer.startActiveSpan('work', (span) => {
      new Logger('Svc').info({ event: 'x' }, 'inside');
      span.end();
    });
    const { traceId, spanId } = exporter.getFinishedSpans().at(-1)!.spanContext();
    assert.equal(lines[0].trace_id, traceId);
    assert.equal(lines[0].span_id, spanId);
  });

  it('a line outside any span has neither', () => {
    const lines = captureLogs();
    new Logger('Svc').info('boot');
    assert.equal('trace_id' in lines[0], false);
    assert.equal('span_id' in lines[0], false);
  });

  it('a span that is not sampled is left off — its trace is never exported', () => {
    const lines = captureLogs();
    const unsampled = trace.wrapSpanContext({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: TraceFlags.NONE,
    });
    context.with(trace.setSpan(context.active(), unsampled), () => new Logger('Svc').info('x'));
    assert.equal('trace_id' in lines[0], false);
  });

  it('the scope context and the trace IDs sit side by side', async () => {
    const lines = captureLogs();
    await tracer.startActiveSpan('job', async (span) => {
      await runWithLogContext({ correlationId: 'c-1', accountId: 3 }, async () => {
        new Logger('Svc').info('in a job');
      });
      span.end();
    });
    assert.equal(lines[0].correlationId, 'c-1');
    assert.equal(lines[0].accountId, 3);
    assert.equal(lines[0].trace_id, exporter.getFinishedSpans().at(-1)!.spanContext().traceId);
  });
});

describe('request context on the HTTP server span', () => {
  // Stands in for what a traced Nest + Fastify request looks like (checked
  // against the real stack): the HTTP instrumentation opens the SERVER span and
  // leaves it in the context's RPC metadata; Fastify's instrumentation runs
  // everything from its onRequest hooks on — the middleware included, then
  // guards and handlers — under a child `request` span.
  async function tracedRequest(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<{ lines: Record<string, any>[]; correlationId: string | null }> {
    const lines = captureLogs();
    exporter.reset();
    const middleware = requestLoggingMiddleware();
    const http = createServer((req, res) => {
      const server = tracer.startSpan('GET /orders', { kind: SpanKind.SERVER });
      res.once('finish', () => server.end());
      const ctx = setRPCMetadata(trace.setSpan(context.active(), server), { type: RPCType.HTTP, span: server });
      context.with(ctx, () =>
        tracer.startActiveSpan('request', (fastify) => {
          res.once('finish', () => fastify.end());
          middleware(req, res, () => handler(req, res));
        }),
      );
    });
    await new Promise<void>((resolve) => http.listen(0, resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(http.address() as AddressInfo).port}/orders`);
      await response.text();
      // the access line is written on 'finish', just after the client reads
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { lines, correlationId: response.headers.get('x-request-id') };
    } finally {
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    }
  }

  function finished(name: string) {
    const span = exporter.getFinishedSpans().find((s) => s.name === name);
    assert.ok(span, `no finished ${name} span`);
    return span;
  }

  it('an authenticated request: correlation, account and user on the server span, not the child', async () => {
    const { lines, correlationId } = await tracedRequest((_req, res) => {
      // what the auth guard does once it has resolved the caller
      setLogContext({ accountId: 42, userId: 7 });
      new Logger('OrdersService').info('listing orders');
      res.end('ok');
    });
    const server = finished('GET /orders');
    assert.deepEqual(server.attributes, {
      'ordersail.correlation_id': correlationId,
      'ordersail.account_id': 42,
      'ordersail.user_id': 7,
    });
    assert.deepEqual(finished('request').attributes, {});

    const service = lines.find((line) => line.context === 'OrdersService');
    const access = lines.find((line) => line.event === 'http.request');
    assert.ok(service && access);
    // a service line points at the span it was written in …
    assert.equal(service.trace_id, server.spanContext().traceId);
    assert.equal(service.span_id, finished('request').spanContext().spanId);
    // … the access line at the request's own span
    assert.equal(access.trace_id, server.spanContext().traceId);
    assert.equal(access.span_id, server.spanContext().spanId);
  });

  it('a public route: only the correlation ID', async () => {
    const { correlationId } = await tracedRequest((_req, res) => res.end('ok'));
    assert.deepEqual(finished('GET /orders').attributes, { 'ordersail.correlation_id': correlationId });
  });

  // The Stripe webhook's shape: a public route whose domain-event handler opens
  // its own scope (CheckoutOrderHandler) with the tenant the event names.
  it('a scope opened inside a request leaves the request’s span alone', async () => {
    const { lines, correlationId } = await tracedRequest(async (_req, res) => {
      await runWithLogContext({ correlationId: 'evt-1', accountId: 9 }, async () => {
        setLogContext({ orderId: 3 });
        new Logger('CheckoutOrderHandler').info('resolving');
      });
      res.end('ok');
    });
    assert.deepEqual(finished('GET /orders').attributes, { 'ordersail.correlation_id': correlationId });
    assert.deepEqual(finished('request').attributes, {});

    // its lines still carry its own context
    const line = lines.find((l) => l.context === 'CheckoutOrderHandler');
    assert.ok(line);
    assert.equal(line.correlationId, 'evt-1');
    assert.equal(line.accountId, 9);
    assert.equal(line.orderId, 3);
  });

  it('with no HTTP server span in the context, the active span is the scope span', async () => {
    exporter.reset();
    await tracer.startActiveSpan('job', async (span) => {
      await runWithLogContext({ correlationId: 'c-2' }, async () => setLogContext({ orderId: 5 }));
      span.end();
    });
    assert.deepEqual(finished('job').attributes, {
      'ordersail.correlation_id': 'c-2',
      'ordersail.order_id': 5,
    });
  });
});
