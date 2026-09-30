import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, it } from 'node:test';
import * as Sentry from '@sentry/node';
import { NotFoundException, UnauthorizedException, type ArgumentsHost } from '@nestjs/common';
import { configureLogging, LoggingExceptionFilter, runWithLogContext, setLogContext } from 'logging';
import { initSentry, scrubEvent } from './index.ts';

// a syntactically valid DSN — the in-memory transport means nothing is sent
const TEST_DSN = 'https://public@o0.ingest.us.sentry.io/0';
const indexPath = fileURLToPath(new URL('./index.ts', import.meta.url));

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

// Sentry is process-global, so anything about a *fresh* process — the no-DSN
// no-op, what init installs, a crash — runs in a child. Its last stdout line is
// the result.
async function runChild(body: string): Promise<{ code: number | null; result: any }> {
  const script = `
    import * as logging from 'logging';
    import * as Sentry from '@sentry/node';
    import { initSentry } from ${JSON.stringify(indexPath)};
    logging.configureLogging({ service: 'test', nodeEnv: 'production', level: 'silent' });
    const print = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
    ${body}
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
  });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  const lines = stdout.trim().split('\n').filter(Boolean);
  return { code, result: lines.length ? JSON.parse(lines.at(-1)!) : undefined };
}

describe('initSentry in a fresh process', () => {
  it('without a DSN does nothing — no client, so nothing can be sent', async () => {
    const { result } = await runChild(`
      print({
        initialised: initSentry({ service: 'test', dsn: undefined, environment: 'test' }),
        isInitialized: Sentry.isInitialized(),
      });
    `);
    assert.deepEqual(result, { initialised: false, isInitialized: false });
  });

  // The point of minimal mode: Sentry installs nothing we didn't ask for — no
  // auto-instrumentation that could capture on its own (the Nest integration
  // reported failing @OnEvent handlers a second time), no process handlers
  // racing installProcessHandlers().
  it('installs only the allowlisted integrations and no process handlers', async () => {
    const { result } = await runChild(`
      const before = ['uncaughtException', 'unhandledRejection'].map((e) => process.listenerCount(e));
      initSentry({ service: 'test', dsn: ${JSON.stringify(TEST_DSN)}, environment: 'test' });
      const after = ['uncaughtException', 'unhandledRejection'].map((e) => process.listenerCount(e));
      print({
        integrations: Sentry.getClient().getOptions().integrations.map((i) => i.name).sort(),
        processListenersAdded: after.map((count, i) => count - before[i]),
      });
    `);
    assert.deepEqual(result, {
      // SpanStreaming is added by the SDK core itself; it only acts on spans,
      // and with no tracesSampleRate there are none
      integrations: ['ContextLines', 'LinkedErrors', 'SpanStreaming'],
      processListenersAdded: [0, 0],
    });
  });

  it('a fatal crash is captured and flushed before the process exits', async () => {
    const { code, result } = await runChild(`
      const events = [];
      initSentry({
        service: 'merchant-api',
        dsn: ${JSON.stringify(TEST_DSN)},
        environment: 'production',
        // the real transport, over a slow network
        transport: (options) => Sentry.createTransport(options, async (request) => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          const lines = String(request.body).split('\\n').filter(Boolean).map((line) => JSON.parse(line));
          for (let i = 1; i < lines.length; i += 2) if (lines[i].type === 'event') events.push(lines[i + 1]);
          return { statusCode: 200 };
        }),
      });
      process.on('exit', () => print(events.map((e) => ({
        level: e.level,
        message: e.exception.values[0].value,
        event: e.tags.event,
      }))));
      logging.installProcessHandlers();
      Promise.reject(new Error('nobody caught me'));
    `);
    assert.equal(code, 1);
    assert.deepEqual(result, [
      { level: 'fatal', message: 'nobody caught me', event: 'process.unhandled_rejection' },
    ]);
  });
});

describe('initSentry with a DSN', () => {
  const sent: Record<string, any>[] = [];
  const filter = () => new LoggingExceptionFilter(adapter);
  const orderRoute = { method: 'GET', route: { path: '/orders/:id' } };

  before(() => {
    configureLogging({ service: 'test', nodeEnv: 'production', level: 'silent' });
    const options = {
      service: 'merchant-api',
      dsn: TEST_DSN,
      environment: 'production',
      release: 'abc123',
      transport: memoryTransport(sent),
    };
    assert.equal(initSentry(options), true);
    // a second call is a no-op — errors are still reported once
    assert.equal(initSentry(options), true);
  });
  beforeEach(() => void (sent.length = 0));

  it('a 5xx is captured once, tagged with release, environment, service and the log context', async () => {
    await runWithLogContext({ correlationId: 'req-1', accountId: 42 }, async () => {
      setLogContext({ userId: 7 });
      filter().catch(new Error('db exploded', { cause: new Error('connection reset') }), httpHost(orderRoute));
    });
    await Sentry.flush(1000);

    assert.equal(sent.length, 1, 'once, even though initSentry ran twice');
    const [event] = sent;
    assert.deepEqual(
      event.exception.values.map((exception: { value: string }) => exception.value),
      ['connection reset', 'db exploded'],
      'the cause chain is kept',
    );
    assert.equal(event.release, 'abc123');
    assert.equal(event.environment, 'production');
    assert.deepEqual(event.tags, {
      service: 'merchant-api',
      correlation_id: 'req-1',
      account_id: 42,
      user_id: 7,
      method: 'GET',
      route: '/orders/:id',
      status: 500,
    });
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

  // Through a real Node HTTP server: with no integrations Sentry has no view of
  // the request at all, so no header, cookie, body or query string can leak.
  describe('over a real HTTP request', () => {
    let server: ReturnType<typeof createServer>;
    let url: string;

    before(async () => {
      server = createServer((req, res) => {
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

    it('the event carries no request data', async () => {
      await fetch(`${url}/customers?search=jane@example.com`, {
        method: 'POST',
        headers: { authorization: 'Bearer secret-jwt', cookie: 'refresh_token=secret-refresh' },
        body: JSON.stringify({ password: 'hunter2' }),
      });
      await Sentry.flush(1000);

      assert.equal(sent.length, 1);
      assert.equal(sent[0].request, undefined);
      assert.deepEqual(sent[0].breadcrumbs ?? [], []);
      const serialized = JSON.stringify(sent[0]);
      for (const secret of ['secret-jwt', 'secret-refresh', 'jane@example.com', 'hunter2']) {
        assert.ok(!serialized.includes(secret), `event leaked ${secret}`);
      }
      assert.equal(sent[0].tags.correlation_id, 'req-2');
    });
  });
});

describe('scrubEvent', () => {
  it("drops a failed query's bound values but keeps the statement", () => {
    // the real DrizzleQueryError message shape (drizzle-orm/errors.js)
    const event = scrubEvent({
      type: undefined,
      exception: {
        values: [
          {
            type: 'DrizzleQueryError',
            value: 'Failed query: select "id" from "users" where "users"."email" = $1\nparams: jane@example.com',
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
});
