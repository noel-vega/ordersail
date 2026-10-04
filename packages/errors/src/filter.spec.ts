import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { IncomingMessage } from 'node:http';
import { NotFoundException, UnauthorizedException, type ArgumentsHost } from '@nestjs/common';
import { runWithLogContext, setRequestRoute } from 'logging';
import { captureLogs, fakeAdapter, httpHost } from 'logging/test-helpers';
import { ApiErrorFilter } from './filter.ts';

const expressRequest = { method: 'GET', route: { path: '/orders/:id' } };

describe('ApiErrorFilter', () => {
  it('replies with the envelope, request_id from the log context, and logs one error line for a 500', async () => {
    const lines = captureLogs();
    const { adapter, replies } = fakeAdapter();
    await runWithLogContext({ correlationId: 'req-1', accountId: 42 }, async () => {
      new ApiErrorFilter(adapter).catch(new Error('db exploded'), httpHost(expressRequest));
    });

    assert.equal(replies.length, 1);
    assert.equal(replies[0].status, 500);
    assert.deepEqual(replies[0].body, {
      error: {
        type: 'api_error',
        code: 'internal_error',
        message: 'Something went wrong on our end.',
        doc_url: 'https://ordersail.com/docs/errors/internal-error',
        request_id: 'req-1',
      },
    });
    assert.ok(!JSON.stringify(replies).includes('db exploded'));

    assert.equal(lines.length, 1, 'exactly one log line');
    assert.equal(lines[0].level, 'error');
    assert.equal(lines[0].event, 'http.unhandled_error');
    assert.equal(lines[0].route, '/orders/:id');
    assert.equal(lines[0].correlationId, 'req-1');
    assert.match(lines[0].err.stack, /db exploded/);
  });

  it('logs a rejected request at the same level as today (401 warn, 404 debug)', () => {
    const lines = captureLogs({ level: 'debug' });
    const filter = new ApiErrorFilter(fakeAdapter().adapter);
    filter.catch(new UnauthorizedException(), httpHost(expressRequest));
    filter.catch(new NotFoundException(), httpHost(expressRequest));
    assert.deepEqual(
      lines.map((line) => [line.level, line.event, line.status]),
      [
        ['warn', 'http.request_rejected', 401],
        ['debug', 'http.request_rejected', 404],
      ],
    );
  });

  it("answers a Fastify request (the route read off its raw request)", () => {
    const lines = captureLogs({ level: 'debug' });
    const raw = { method: 'POST' } as IncomingMessage;
    setRequestRoute(raw, '/webhooks/stripe');
    const { adapter, replies } = fakeAdapter();
    new ApiErrorFilter(adapter).catch(new NotFoundException(), httpHost({ raw }));
    assert.equal(lines[0].route, '/webhooks/stripe');
    assert.equal(replies[0].status, 404);
  });

  it('logs an untrusted error with a statusCode as the 500 the client gets', () => {
    const lines = captureLogs({ level: 'debug' });
    const { adapter, replies } = fakeAdapter();
    const stripeError = Object.assign(new Error('Your card was declined.'), { statusCode: 402, code: 'card_declined' });
    new ApiErrorFilter(adapter).catch(stripeError, httpHost(expressRequest));
    assert.equal(replies[0].status, 500);
    assert.deepEqual(
      [lines[0].level, lines[0].event, lines[0].status],
      ['error', 'http.unhandled_error', 500],
    );
  });

  it('ends a response whose headers were already sent instead of replying', () => {
    captureLogs();
    const { adapter, replies, ended } = fakeAdapter({ headersSent: true });
    new ApiErrorFilter(adapter).catch(new Error('mid-stream'), httpHost(expressRequest));
    assert.equal(replies.length, 0);
    assert.equal(ended(), 1);
  });

  it('rethrows outside an HTTP context instead of swallowing the error', () => {
    const error = new Error('rpc');
    const host = { getType: () => 'rpc' } as unknown as ArgumentsHost;
    assert.throws(() => new ApiErrorFilter(fakeAdapter().adapter).catch(error, host), error);
  });
});
