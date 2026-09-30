import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, it } from 'node:test';
import * as Sentry from '@sentry/nestjs';
import type { ArgumentsHost } from '@nestjs/common';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import {
  configureLogging,
  LoggingExceptionFilter,
  runWithLogContext,
  SENSITIVE_KEYS,
  setLogContext,
} from 'logging';
import { initSentry, scrubEvent } from './index.ts';

// a syntactically valid DSN — the in-memory transport means nothing is sent
const TEST_DSN = 'https://public@o0.ingest.us.sentry.io/0';

// Sentry's real transport (buffering, flush) with the network swapped for an
// array: each request body is the serialized envelope exactly as it would go on
// the wire — newline-delimited JSON, an item header followed by its payload.
function memoryTransport(sent: Record<string, any>[]): NonNullable<Sentry.NodeOptions['transport']> {
  return (options) =>
    Sentry.createTransport(options, async (request) => {
      const lines = String(request.body).split('\n').filter(Boolean).map((line) => JSON.parse(line));
      for (let i = 1; i < lines.length; i += 2) {
        if (lines[i].type === 'event') sent.push(lines[i + 1]);
      }
      return { statusCode: 200 };
    });
}

// the slice of Nest's HttpServer adapter LoggingExceptionFilter answers through
const adapter = { reply: () => undefined, isHeadersSent: () => false, end: () => undefined } as any;

function httpHost(request: unknown): ArgumentsHost {
  return {
    getType: () => 'http',
    getArgByIndex: (index: number) => [request, {}][index],
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
  } as unknown as ArgumentsHost;
}

// Must run first: Sentry is process-global, and the describe below initialises it.
describe('initSentry without a DSN', () => {
  it('does nothing — no client, so nothing can be sent', () => {
    assert.equal(initSentry({ service: 'test', dsn: undefined, environment: 'test' }), false);
    assert.equal(Sentry.getClient(), undefined);
  });
});

describe('initSentry with a DSN', () => {
  const sent: Record<string, any>[] = [];
  const filter = () => new LoggingExceptionFilter(adapter);
  const orderRoute = { method: 'GET', route: { path: '/orders/:id' } };

  before(() => {
    configureLogging({ service: 'test', nodeEnv: 'production', level: 'silent' });
    const initialised = initSentry({
      service: 'merchant-api',
      dsn: TEST_DSN,
      environment: 'production',
      release: 'abc123',
      transport: memoryTransport(sent),
    });
    assert.equal(initialised, true);
  });
  beforeEach(() => void (sent.length = 0));

  it('a 5xx is captured once, tagged with release, environment, service and the log context', async () => {
    await runWithLogContext({ correlationId: 'req-1', accountId: 42 }, async () => {
      setLogContext({ userId: 7 });
      filter().catch(new Error('db exploded'), httpHost(orderRoute));
    });
    await Sentry.flush(1000);

    assert.equal(sent.length, 1);
    const [event] = sent;
    assert.equal(event.exception.values[0].value, 'db exploded');
    assert.equal(event.release, 'abc123');
    assert.equal(event.environment, 'production');
    assert.deepEqual(
      {
        service: event.tags.service,
        correlation_id: event.tags.correlation_id,
        account_id: event.tags.account_id,
        user_id: event.tags.user_id,
        route: event.tags.route,
        status: event.tags.status,
      },
      {
        service: 'merchant-api',
        correlation_id: 'req-1',
        account_id: 42,
        user_id: 7,
        route: '/orders/:id',
        status: 500,
      },
    );
    assert.ok(!('customer_id' in event.tags), 'unset context fields are not tagged');
  });

  it('4xx is never captured', async () => {
    filter().catch(new UnauthorizedException(), httpHost(orderRoute));
    filter().catch(new NotFoundException(), httpHost(orderRoute));
    await Sentry.flush(1000);
    assert.deepEqual(sent, []);
  });

  it('a failing /health probe is not captured', async () => {
    filter().catch(new Error('redis down'), httpHost({ method: 'GET', route: { path: '/health' } }));
    await Sentry.flush(1000);
    assert.deepEqual(sent, []);
  });

  // End to end through a real Node HTTP server, so the request data on the
  // event is whatever Sentry's own http instrumentation really collects — not
  // a hand-written fixture of what we think it looks like.
  describe('over a real HTTP request', () => {
    let server: ReturnType<typeof createServer>;
    let url: string;

    before(async () => {
      // captures synchronously in the handler, as Nest's filter does after a
      // controller throws, so Sentry's request context is still active
      server = createServer((req: IncomingMessage, res) => {
        runWithLogContext({ correlationId: 'req-2' }, () => {
          filter().catch(new Error('boom'), httpHost(Object.assign(req, { route: { path: '/customers' } })));
        });
        res.statusCode = 500;
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it('sends no credentials, cookies, body or query string', async () => {
      const body = JSON.stringify({ email: 'jane@example.com', password: 'hunter2' });
      await fetch(`${url}/customers?search=jane@example.com&token=abc`, {
        method: 'POST',
        headers: {
          'user-agent': 'integration-test',
          authorization: 'Bearer secret-jwt',
          cookie: 'refresh_token=secret-refresh',
          'stripe-signature': 't=1,v1=secret-sig',
          'x-app-key': 'secret-app-key',
          'x-pos-device-token': 'secret-device',
          'x-cart-token': 'secret-cart',
          'x-request-id': 'req-2',
          'content-type': 'application/json',
        },
        body,
      });
      await Sentry.flush(1000);

      assert.equal(sent.length, 1);
      const serialized = JSON.stringify(sent[0]);
      for (const secret of [
        'secret-jwt',
        'secret-refresh',
        'secret-sig',
        'secret-app-key',
        'secret-device',
        'secret-cart',
        'jane@example.com',
        'hunter2',
        'token=abc',
      ]) {
        assert.ok(!serialized.includes(secret), `event leaked ${secret}`);
      }
      // still enough to triage
      assert.equal(sent[0].tags.correlation_id, 'req-2');
      assert.equal(sent[0].tags.method, 'POST');
      assert.equal(sent[0].tags.route, '/customers');
      // Sentry's own request data did reach the event — scrubbed
      assert.deepEqual(sent[0].request, {
        method: 'POST',
        url: `${url}/customers`,
        headers: {
          accept: '*/*',
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          'user-agent': 'integration-test',
          'x-request-id': 'req-2',
        },
      });
    });
  });
});

describe('scrubEvent', () => {
  it('censors every OS-81 sensitive key in extra, contexts and breadcrumbs, at any depth', () => {
    const nested = Object.fromEntries(SENSITIVE_KEYS.map((key) => [key, `leak-${key}`]));
    const event = scrubEvent({
      type: undefined,
      extra: { ...nested, deeper: { list: [nested] } },
      contexts: { job: nested },
      breadcrumbs: [{ category: 'http', data: { ...nested, url: 'https://api.stripe.com/v1/x?email=a@b.c' } }],
    });
    const serialized = JSON.stringify(event);
    for (const key of SENSITIVE_KEYS) assert.ok(!serialized.includes(`leak-${key}`), `${key} leaked`);
    assert.equal(event.breadcrumbs?.[0].data?.url, 'https://api.stripe.com/v1/x');
  });

  it("drops a failed query's bound values but keeps the statement", () => {
    // the real DrizzleQueryError message shape (drizzle-orm pg-core session)
    const event = scrubEvent({
      type: undefined,
      exception: {
        values: [
          {
            type: 'DrizzleQueryError',
            value:
              'Failed query: select "id" from "users" where "users"."email" = $1\nparams: jane@example.com',
          },
          { type: 'error', value: 'connection terminated unexpectedly' },
        ],
      },
    });
    assert.deepEqual(
      event.exception?.values?.map((exception) => exception.value),
      [
        'Failed query: select "id" from "users" where "users"."email" = $1\nparams: [REDACTED]',
        'connection terminated unexpectedly',
      ],
    );
  });

  it('keeps only allowlisted request headers, drops body, cookies and query string', () => {
    const event = scrubEvent({
      type: undefined,
      request: {
        url: 'https://api.ordersail.com/auth/reset-password?token=abc',
        method: 'POST',
        query_string: 'token=abc',
        cookies: { refresh_token: 'x' },
        data: { password: 'hunter2' },
        headers: {
          Authorization: 'Bearer x',
          'user-agent': 'curl/8',
          'x-request-id': 'req-3',
          'stripe-signature': 'sig',
        },
      },
    });
    assert.deepEqual(event.request, {
      url: 'https://api.ordersail.com/auth/reset-password',
      method: 'POST',
      headers: { 'user-agent': 'curl/8', 'x-request-id': 'req-3' },
    });
  });
});

// exitOnFatal needs a real process: it exits.
describe('a fatal crash', () => {
  const indexPath = fileURLToPath(new URL('./index.ts', import.meta.url));

  it('is captured and flushed before the process exits', async () => {
    const script = `
      import * as logging from 'logging';
      import * as Sentry from '@sentry/nestjs';
      import { initSentry } from ${JSON.stringify(indexPath)};
      logging.configureLogging({ service: 'test', nodeEnv: 'production', level: 'silent' });
      initSentry({
        service: 'merchant-api',
        dsn: ${JSON.stringify(TEST_DSN)},
        environment: 'production',
        // the real transport, over a slow network
        transport: (options) => Sentry.createTransport(options, async (request) => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          const lines = String(request.body).split('\\n').filter(Boolean).map((line) => JSON.parse(line));
          for (let i = 1; i < lines.length; i += 2) {
            if (lines[i].type === 'event') process.stdout.write(JSON.stringify(lines[i + 1]) + '\\n');
          }
          return { statusCode: 200 };
        }),
      });
      logging.installProcessHandlers();
      Promise.reject(new Error('nobody caught me'));
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
    const code = await new Promise((resolve) => child.on('close', resolve));

    assert.equal(code, 1);
    const events = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(events.length, 1, 'captured once — Sentry\'s own unhandledRejection handler is off');
    assert.equal(events[0].level, 'fatal');
    assert.equal(events[0].exception.values[0].value, 'nobody caught me');
    assert.equal(events[0].tags.event, 'process.unhandled_rejection');
  });
});
