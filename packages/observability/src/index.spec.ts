import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { before, beforeEach, describe, it } from 'node:test';
import { NotFoundException, UnauthorizedException, type ArgumentsHost } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { configureLogging, LoggingExceptionFilter, runWithLogContext, setLogContext } from 'logging';
import { initSentry, scrubEvent } from './index.ts';

// The real SDK with an in-memory transport: events go through the same
// integrations, processors and beforeSend as in production, and are read back
// off the envelopes the SDK would have put on the wire (JSON round-tripped).
const sent: Record<string, any>[] = [];

const transport: InitSentryTransport = () => ({
  send: async (envelope) => {
    const [, items] = JSON.parse(JSON.stringify(envelope)) as [unknown, [{ type: string }, unknown][]];
    for (const [header, payload] of items) {
      if (header.type === 'event') sent.push(payload as Record<string, any>);
    }
    return {};
  },
  flush: async () => true,
});

type InitSentryTransport = NonNullable<Parameters<typeof initSentry>[0]['transport']>;

const DSN = 'https://public@o0.ingest.sentry.io/0';

function httpHost(request: unknown): ArgumentsHost {
  const response = {};
  return {
    getType: () => 'http',
    getArgByIndex: (index: number) => [request, response][index],
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
}

function fakeAdapter() {
  return {
    reply: () => undefined,
    isHeadersSent: () => false,
    end: () => undefined,
  } as any;
}

const request = { method: 'GET', route: { path: '/orders/:id' } };

describe('initSentry', () => {
  it('stays off without a DSN', () => {
    assert.equal(initSentry({ service: 'test', environment: 'test' }), false);
    assert.equal(Sentry.getClient(), undefined);
  });

  describe('with a DSN', () => {
    before(() => {
      configureLogging({ service: 'test', nodeEnv: 'test', level: 'silent' });
      assert.equal(
        initSentry({
          service: 'merchant-api',
          dsn: DSN,
          environment: 'production',
          release: 'abc123',
          transport,
        }),
        true,
      );
    });

    beforeEach(() => {
      sent.length = 0;
    });

    it("an unhandled 5xx becomes one event tagged with the request's context", async () => {
      await runWithLogContext({ correlationId: 'req-1', accountId: 42 }, async () => {
        setLogContext({ userId: 7 });
        new LoggingExceptionFilter(fakeAdapter()).catch(new Error('db exploded'), httpHost(request));
      });
      await Sentry.flush(1000);

      assert.equal(sent.length, 1);
      const [event] = sent;
      assert.equal(event.level, 'error');
      assert.equal(event.release, 'abc123');
      assert.equal(event.environment, 'production');
      assert.equal(event.exception.values[0].value, 'db exploded');
      assert.deepEqual(event.tags, {
        service: 'merchant-api',
        event: 'http.unhandled_error',
        route: '/orders/:id',
        status: '500',
        correlation_id: 'req-1',
        account_id: '42',
        user_id: '7',
      });
    });

    it('4xx never reaches Sentry', async () => {
      const filter = new LoggingExceptionFilter(fakeAdapter());
      filter.catch(new UnauthorizedException(), httpHost(request));
      filter.catch(new NotFoundException(), httpHost(request));
      await Sentry.flush(1000);
      assert.deepEqual(sent, []);
    });

    it('a failing /health (503 while a dependency is down) is not reported', async () => {
      const unavailable = Object.assign(new Error('Service Unavailable'), {
        statusCode: 503,
      });
      new LoggingExceptionFilter(fakeAdapter()).catch(
        unavailable,
        httpHost({ method: 'GET', route: { path: '/health' } }),
      );
      await Sentry.flush(1000);
      assert.deepEqual(sent, []);
    });

    it('library console output does not ride along as breadcrumbs', async () => {
      // a runtime value: a literal would show up anyway, in the source context
      // lines around the captured frame, which is code, not data
      const payload = randomUUID();
      console.error('[library] Unhandled error event:', { payload });
      Sentry.captureException(new Error('after some library chatter'));
      await Sentry.flush(1000);
      assert.equal(sent.length, 1);
      assert.ok(!JSON.stringify(sent).includes(payload));
    });

    it('an event the SDK captures on its own still gets the log context tags', async () => {
      await runWithLogContext({ correlationId: 'job-9', accountId: 3 }, async () => {
        Sentry.captureException(new Error('@OnEvent handler failed'));
      });
      await Sentry.flush(1000);
      assert.equal(sent[0].tags.correlation_id, 'job-9');
      assert.equal(sent[0].tags.account_id, '3');
      assert.equal(sent[0].tags.service, 'merchant-api');
    });
  });
});

describe('scrubEvent', () => {
  it('keeps only allow-listed request headers and drops cookies, bodies and query strings', () => {
    const event = scrubEvent({
      request: {
        url: 'https://merchant.ordersail.com/api/auth/magic-link?token=secret',
        method: 'POST',
        query_string: 'token=secret',
        cookies: { refresh: 'secret' },
        data: { email: 'a@b.co', password: 'hunter2' },
        headers: {
          authorization: 'Bearer secret',
          cookie: 'refresh=secret',
          'stripe-signature': 't=1,v1=secret',
          'x-app-key': 'secret',
          'X-Some-New-Auth': 'secret',
          'user-agent': 'curl/8',
          'x-request-id': 'req-1',
        },
      },
    });
    assert.deepEqual(event.request, {
      url: 'https://merchant.ordersail.com/api/auth/magic-link',
      method: 'POST',
      headers: { 'user-agent': 'curl/8', 'x-request-id': 'req-1' },
    });
  });

  it("strips a person's details off event.user, keeping the id", () => {
    const event = scrubEvent({
      user: {
        id: '7',
        email: 'a@b.co',
        ip_address: '1.2.3.4',
        username: 'ann',
      },
    });
    assert.deepEqual(event.user, { id: '7' });
  });

  it("redacts the logging package's sensitive keys in extra, contexts and breadcrumbs", () => {
    const event = scrubEvent({
      extra: { orderId: 1, customer: { email: 'a@b.co', token: 't' } },
      contexts: { stripe: { apiKey: 'sk_live_x', mode: 'live' } },
      breadcrumbs: [
        {
          category: 'http',
          data: { url: 'https://api.stripe.com/v1/x?expand=y', password: 'p' },
        },
      ],
    });
    assert.deepEqual(event.extra, {
      orderId: 1,
      customer: { email: '[REDACTED]', token: '[REDACTED]' },
    });
    assert.deepEqual(event.contexts, {
      stripe: { apiKey: '[REDACTED]', mode: 'live' },
    });
    assert.deepEqual(event.breadcrumbs?.[0].data, {
      url: 'https://api.stripe.com/v1/x',
      password: '[REDACTED]',
    });
  });
});

// A crash is reported and flushed before the process exits — needs a real process.
describe('fatal errors', () => {
  const indexPath = fileURLToPath(new URL('./index.ts', import.meta.url));

  it('a crash reaches the transport at level fatal before exit(1)', async () => {
    const script = `
      import * as logging from 'logging';
      import { initSentry } from ${JSON.stringify(indexPath)};
      logging.configureLogging({ service: 'test', nodeEnv: 'production', level: 'silent' });
      initSentry({
        service: 'worker',
        dsn: ${JSON.stringify(DSN)},
        environment: 'production',
        transport: () => ({
          send: async (envelope) => {
            for (const [header, payload] of envelope[1]) {
              if (header.type === 'event') console.log(JSON.stringify({ level: payload.level, tags: payload.tags, value: payload.exception.values[0].value }));
            }
            return {};
          },
          flush: async () => true,
        }),
      });
      logging.installProcessHandlers();
      Promise.reject(new Error('nobody caught me'));
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, NODE_ENV: 'production' },
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    const code = await new Promise((resolve) => child.on('close', resolve));

    assert.equal(code, 1);
    const events = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(events, [
      {
        level: 'fatal',
        tags: { service: 'worker', event: 'process.unhandled_rejection' },
        value: 'nobody caught me',
      },
    ]);
  });
});
