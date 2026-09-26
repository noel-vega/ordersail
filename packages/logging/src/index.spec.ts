import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
  type ArgumentsHost,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import {
  configureLogging,
  getCorrelationId,
  getLogContext,
  jobLogContext,
  logContextOf,
  Logger,
  LoggingExceptionFilter,
  maskEmail,
  normalizeLogArgs,
  requestLoggingMiddleware,
  runWithLogContext,
  setLogContext,
  setRequestRoute,
} from './index.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

describe('normalizeLogArgs', () => {
  it('pino style: object first, message second', () => {
    assert.deepEqual(normalizeLogArgs('Svc', { event: 'order.created', orderId: 1 }, ['Order created']), [
      { context: 'Svc', event: 'order.created', orderId: 1 },
      'Order created',
    ]);
  });

  it('pino style: err stays an Error for the serializer', () => {
    const err = new Error('boom');
    const [fields, msg] = normalizeLogArgs('Svc', { err, orderId: 1 }, ['failed']);
    assert.equal(fields.err, err);
    assert.equal(msg, 'failed');
  });

  it('Nest style: trailing string is the context', () => {
    assert.deepEqual(normalizeLogArgs(undefined, 'Mapped {/health, GET} route', ['RouterExplorer']), [
      { context: 'RouterExplorer' },
      'Mapped {/health, GET} route',
    ]);
  });

  it('Nest style: error(message, stack, context)', () => {
    const stack = 'Error: boom\n    at foo (bar.ts:1:1)';
    assert.deepEqual(normalizeLogArgs(undefined, 'boom', [stack, 'ExceptionsHandler']), [
      { context: 'ExceptionsHandler', stack },
      'boom',
    ]);
  });

  it('Nest style: error(message, stack) keeps the instance context', () => {
    const stack = 'Error: boom\n    at foo (bar.ts:1:1)';
    assert.deepEqual(normalizeLogArgs('EmailService', 'Failed to enqueue', [stack]), [
      { context: 'EmailService', stack },
      'Failed to enqueue',
    ]);
  });

  it('Nest style: error(message, err) maps the Error to err', () => {
    const err = new Error('shippo down');
    const [fields, msg] = normalizeLogArgs('FulfillmentsService', 'Shippo failed', [err]);
    assert.deepEqual(fields, { context: 'FulfillmentsService', err });
    assert.equal(msg, 'Shippo failed');
  });

  it('bare Error uses its message', () => {
    const err = new Error('boom');
    assert.deepEqual(normalizeLogArgs('Svc', err, []), [{ context: 'Svc', err }, 'boom']);
  });

  it('Nest style: a plain-string detail on a logger with its own context stays detail', () => {
    assert.deepEqual(normalizeLogArgs('EmailService', 'Failed to enqueue', ['queue unavailable']), [
      { context: 'EmailService', detail: 'queue unavailable' },
      'Failed to enqueue',
    ]);
  });

  it('non-Error object extras land in detail, reduced to type + message', () => {
    assert.deepEqual(
      normalizeLogArgs('Svc', 'odd rejection', [{ message: 'nope', body: { email: 'jane@example.com' } }]),
      [{ context: 'Svc', detail: { type: 'Object', message: 'nope' } }, 'odd rejection'],
    );
  });
});

describe('log context', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

  it('is visible across awaits inside the scope and absent outside', async () => {
    assert.equal(getCorrelationId(), undefined);
    await runWithLogContext({ correlationId: 'abc' }, async () => {
      await tick();
      assert.equal(getCorrelationId(), 'abc');
    });
    assert.equal(getCorrelationId(), undefined);
  });

  it('fields set mid-scope (as a guard does) reach async work that runs after', async () => {
    await runWithLogContext({ correlationId: 'req-1' }, async () => {
      await tick();
      setLogContext({ accountId: 42, userId: 7 });
      await tick();
      assert.deepEqual(getLogContext(), { correlationId: 'req-1', accountId: 42, userId: 7 });
    });
  });

  it('concurrent scopes do not bleed into each other', async () => {
    const request = (correlationId: string, accountId: number, delay: number) =>
      runWithLogContext({ correlationId }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        setLogContext({ accountId });
        await new Promise((resolve) => setTimeout(resolve, delay));
        return getLogContext();
      });
    const [a, b] = await Promise.all([request('a', 1, 5), request('b', 2, 1)]);
    assert.deepEqual(a, { correlationId: 'a', accountId: 1 });
    assert.deepEqual(b, { correlationId: 'b', accountId: 2 });
  });

  it('setLogContext is a no-op outside a scope and skips undefined fields', async () => {
    setLogContext({ accountId: 1 });
    assert.equal(getLogContext(), undefined);
    await runWithLogContext({ correlationId: 'x', accountId: undefined }, async () => {
      setLogContext({ userId: undefined, deviceId: 3 });
      assert.deepEqual(getLogContext(), { correlationId: 'x', deviceId: 3 });
    });
  });

  it('jobLogContext carries correlationId + accountId, minting an ID with no scope', async () => {
    await runWithLogContext({ correlationId: 'c', accountId: 9, userId: 4 }, async () => {
      assert.deepEqual(jobLogContext(), { correlationId: 'c', accountId: 9 });
    });
    const minted = jobLogContext();
    assert.match(minted.correlationId, /^[0-9a-f-]{36}$/);
    assert.equal('accountId' in minted, false);
  });

  it('logContextOf picks only the log context out of a job payload', () => {
    const payload = { correlationId: 'c', accountId: 9, to: 'a@b.co', firstName: 'Ann' };
    assert.deepEqual(logContextOf(payload), { correlationId: 'c', accountId: 9 });
    const noTenant = { correlationId: 'c', to: 'a@b.co' };
    assert.deepEqual(logContextOf(noTenant), { correlationId: 'c' });
  });

  it('every line in the scope carries the context', async () => {
    const lines = captureLogs();
    await runWithLogContext({ correlationId: 'job-1', accountId: 5 }, async () => {
      setLogContext({ orderId: 11 });
      new Logger('Svc').info({ event: 'order.created' }, 'Order created');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(lines[0].correlationId, 'job-1');
    assert.equal(lines[0].accountId, 5);
    assert.equal(lines[0].orderId, 11);
  });
});

// routes the shared root into memory and returns the parsed lines
function captureLogs(): Record<string, any>[] {
  const lines: Record<string, any>[] = [];
  configureLogging({
    service: 'test',
    nodeEnv: 'production',
    destination: { write: (chunk: string) => void lines.push(JSON.parse(chunk)) },
  });
  return lines;
}

describe('redaction', () => {
  it('censors sensitive keys at the top level and one level deep', () => {
    const lines = captureLogs();
    new Logger('Svc').info(
      {
        email: 'jane@example.com',
        password: 'hunter2',
        user: { email: 'jane@example.com', token: 'abc', id: 7 },
        cartToken: 'cart_123',
      },
      'signup',
    );
    const [line] = lines;
    assert.equal(line.email, '[REDACTED]');
    assert.equal(line.password, '[REDACTED]');
    assert.equal(line.cartToken, '[REDACTED]');
    assert.deepEqual(line.user, { email: '[REDACTED]', token: '[REDACTED]', id: 7 });
  });

  it('censors auth and credential headers', () => {
    const lines = captureLogs();
    new Logger('Http').info(
      {
        req: {
          method: 'GET',
          headers: {
            authorization: 'Bearer eyJ',
            cookie: 'refresh=x',
            'x-app-key': 'ak_live',
            'x-pos-device-token': 'dev',
            'x-cart-token': 'cart',
            'user-agent': 'curl',
          },
        },
        res: { headers: { 'set-cookie': 'refresh=y' } },
      },
      'request',
    );
    const [line] = lines;
    assert.deepEqual(line.req.headers, {
      authorization: '[REDACTED]',
      cookie: '[REDACTED]',
      'x-app-key': '[REDACTED]',
      'x-pos-device-token': '[REDACTED]',
      'x-cart-token': '[REDACTED]',
      'user-agent': 'curl',
    });
    assert.equal(line.res.headers['set-cookie'], '[REDACTED]');
  });

  it('leaves deliberately generic keys alone', () => {
    const lines = captureLogs();
    new Logger('Svc').info({ from: 'pending', to: 'paid', code: 'card_declined' }, 'transition');
    assert.equal(lines[0].to, 'paid');
    assert.equal(lines[0].code, 'card_declined');
  });

  it('does not mutate the caller object', () => {
    captureLogs();
    const fields = { email: 'jane@example.com' };
    new Logger('Svc').info(fields, 'x');
    assert.equal(fields.email, 'jane@example.com');
  });
});

describe('error serialization', () => {
  it('keeps allow-listed fields and drops provider payloads', () => {
    const lines = captureLogs();
    const cause = new Error('socket hang up');
    const err = Object.assign(new Error('Your card was declined.', { cause }), {
      code: 'card_declined',
      statusCode: 402,
      requestId: 'req_123',
      param: 'payment_method',
      raw: { customer_email: 'jane@example.com' },
      headers: { authorization: 'Bearer sk_live' },
      rawResponse: { body: 'secret' },
    });
    new Logger('Payments').error({ err }, 'charge failed');
    const serialized = lines[0].err;
    assert.equal(serialized.type, 'Error');
    assert.equal(serialized.message, 'Your card was declined.');
    assert.ok(serialized.stack.includes('Your card was declined.'));
    assert.equal(serialized.code, 'card_declined');
    assert.equal(serialized.statusCode, 402);
    assert.equal(serialized.requestId, 'req_123');
    assert.equal(serialized.param, 'payment_method');
    assert.equal(serialized.cause.message, 'socket hang up');
    assert.equal(serialized.raw, undefined);
    assert.equal(serialized.headers, undefined);
    assert.equal(serialized.rawResponse, undefined);
  });

  it('reduces an object cause instead of preserving it', () => {
    const lines = captureLogs();
    const err = new Error('shippo failed', {
      cause: { message: 'bad address', request: { addressTo: { email: 'jane@example.com' } } },
    });
    new Logger('Fulfillments').error({ err }, 'label purchase failed');
    assert.deepEqual(lines[0].err.cause, { type: 'Object', message: 'bad address' });
  });

  it('reduces a non-Error object passed as err, keeps primitive rejections', () => {
    const lines = captureLogs();
    new Logger('Svc').error({ err: { status: 500, body: { token: 'x', nested: { secret: 'y' } } } }, 'a');
    new Logger('Svc').error({ err: 'timeout' }, 'b');
    assert.deepEqual(lines[0].err, { type: 'Object' });
    assert.equal(lines[1].err, 'timeout');
  });

  it('applies to Nest-style error(message, err) calls too', () => {
    const lines = captureLogs();
    const err = Object.assign(new Error('boom'), { body: { email: 'jane@example.com' } });
    new Logger('Fulfillments').error('Shippo failed', err);
    assert.equal(lines[0].err.message, 'boom');
    assert.equal(lines[0].err.body, undefined);
  });
});

describe('maskEmail', () => {
  it('keeps the first character and the domain', () => {
    assert.equal(maskEmail('jane@example.com'), 'j***@example.com');
  });

  it('handles malformed input', () => {
    assert.equal(maskEmail('not-an-email'), '***');
    assert.equal(maskEmail('@example.com'), '***');
    assert.equal(maskEmail('jane@'), '***');
  });
});

describe('requestLoggingMiddleware', () => {
  // a bare node:http server standing in for Nest: the middleware runs first,
  // then the handler — which can fake Express's req.route or call
  // setRequestRoute like the Fastify hook does
  async function withServer(
    handler: (req: IncomingMessage & { route?: { path: string } }, res: ServerResponse) => void,
    run: (url: string) => Promise<void>,
  ) {
    const middleware = requestLoggingMiddleware();
    const server = createServer((req, res) => middleware(req, res, () => handler(req, res)));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${port}`);
    } finally {
      // don't wait out the fetch client's idle keep-alive sockets
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  // the access line is written on 'finish', which can land just after the
  // client has read the response
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('logs one line per request with the route template, status and correlation ID', async () => {
    const lines = captureLogs();
    await withServer(
      (req, res) => {
        req.route = { path: '/orders/:id' };
        res.end('ok');
      },
      async (url) => {
        const response = await fetch(`${url}/orders/42?token=secret`);
        await response.text();
        await settle();
        const [line] = lines;
        assert.equal(lines.length, 1);
        assert.equal(line.level, 30);
        assert.equal(line.event, 'http.request');
        assert.equal(line.context, 'HTTP');
        assert.deepEqual(line.req, { method: 'GET' });
        assert.equal(line.route, '/orders/:id');
        assert.deepEqual(line.res, { statusCode: 200 });
        assert.equal(typeof line.responseTime, 'number');
        assert.equal(line.correlationId, response.headers.get('x-request-id'));
        assert.equal(line.msg, 'GET /orders/:id 200');
        const raw = JSON.stringify(line);
        assert.ok(!raw.includes('/orders/42'));
        assert.ok(!raw.includes('secret'));
      },
    );
  });

  it('prefers an explicitly reported route (Fastify)', async () => {
    const lines = captureLogs();
    await withServer(
      (req, res) => {
        setRequestRoute(req, '/products/:productId');
        res.end();
      },
      async (url) => {
        await (await fetch(`${url}/products/9`)).text();
        await settle();
        assert.equal(lines[0].route, '/products/:productId');
      },
    );
  });

  it('logs unmatched 4xx at warn with a null route, 5xx at error', async () => {
    const lines = captureLogs();
    await withServer(
      (req, res) => {
        res.statusCode = req.url === '/boom' ? 500 : 404;
        res.end();
      },
      async (url) => {
        await (await fetch(`${url}/nope`)).text();
        await (await fetch(`${url}/boom`)).text();
        await settle();
        assert.equal(lines[0].level, 40);
        assert.equal(lines[0].route, null);
        assert.equal(lines[0].msg, 'GET (unmatched) 404');
        assert.equal(lines[1].level, 50);
      },
    );
  });

  it('ignores a concrete baseUrl from a mounted router', async () => {
    const lines = captureLogs();
    await withServer(
      (req, res) => {
        Object.assign(req, { baseUrl: '/callbacks/secret-token', route: { path: '/complete' } });
        res.end();
      },
      async (url) => {
        await (await fetch(`${url}/callbacks/secret-token/complete`)).text();
        await settle();
        assert.equal(lines[0].route, '/complete');
        assert.ok(!JSON.stringify(lines[0]).includes('secret-token'));
      },
    );
  });

  it('logs a client abort at warn without a status code', async () => {
    const lines = captureLogs();
    await withServer(
      // never responds; the client gives up first
      () => undefined,
      async (url) => {
        const controller = new AbortController();
        const pending = fetch(`${url}/slow`, { signal: controller.signal }).catch(() => undefined);
        setTimeout(() => controller.abort(), 30);
        await pending;
        for (let i = 0; i < 50 && lines.length === 0; i++) await settle();
        const [line] = lines;
        assert.equal(line.aborted, true);
        assert.equal(line.res, undefined);
        assert.equal(line.level, 40);
        assert.equal(line.msg, 'GET (unmatched) aborted');
      },
    );
  });

  it('skips /health, with or without a query string', async () => {
    const lines = captureLogs();
    await withServer(
      (_req, res) => res.end(),
      async (url) => {
        await (await fetch(`${url}/health`)).text();
        await (await fetch(`${url}/health?probe=alb`)).text();
        await settle();
        assert.equal(lines.length, 0);
      },
    );
  });

  it('reuses a well-formed inbound x-request-id and replaces a malformed one', async () => {
    captureLogs();
    const seen: (string | undefined)[] = [];
    await withServer(
      (_req, res) => {
        seen.push(getCorrelationId());
        res.end();
      },
      async (url) => {
        const good = await fetch(url, { headers: { 'x-request-id': 'abc-123.def:4' } });
        await good.text();
        assert.equal(good.headers.get('x-request-id'), 'abc-123.def:4');

        for (const bad of ['has spaces', 'x'.repeat(200), '{"json":1}']) {
          const response = await fetch(url, { headers: { 'x-request-id': bad } });
          await response.text();
          const echoed = response.headers.get('x-request-id');
          assert.notEqual(echoed, bad);
          assert.match(echoed ?? '', /^[0-9a-f-]{36}$/);
        }
        // the handler ran inside the scope with the same ID that was echoed
        assert.equal(seen[0], 'abc-123.def:4');
      },
    );
  });

  it('carries identity a guard set mid-request on service lines and the access line', async () => {
    const lines = captureLogs();
    await withServer(
      (_req, res) => {
        setLogContext({ accountId: 42, userId: 7 });
        new Logger('Svc').info({ event: 'thing.done' }, 'done');
        res.end();
      },
      async (url) => {
        await (await fetch(url)).text();
        await settle();
        const service = lines.find((line) => line.event === 'thing.done');
        const access = lines.find((line) => line.event === 'http.request');
        for (const line of [service, access]) {
          assert.equal(line?.accountId, 42);
          assert.equal(line?.userId, 7);
        }
        assert.equal(service?.correlationId, access?.correlationId);
      },
    );
  });
});

describe('LoggingExceptionFilter', () => {
  function captureAll(): Record<string, any>[] {
    const lines: Record<string, any>[] = [];
    configureLogging({
      service: 'test',
      nodeEnv: 'production',
      level: 'debug',
      destination: { write: (chunk: string) => void lines.push(JSON.parse(chunk)) },
    });
    return lines;
  }

  // the slice of Nest's HttpServer adapter the filters answer through
  function fakeAdapter() {
    const replies: { body: unknown; status: number }[] = [];
    const adapter = {
      reply: (_res: unknown, body: unknown, status: number) => void replies.push({ body, status }),
      isHeadersSent: () => false,
      end: () => undefined,
    };
    return { adapter: adapter as any, replies };
  }

  function httpHost(request: unknown): ArgumentsHost {
    const response = {};
    return {
      getType: () => 'http',
      getArgByIndex: (index: number) => [request, response][index],
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    } as unknown as ArgumentsHost;
  }

  const expressRequest = { method: 'GET', route: { path: '/orders/:id' } };

  // the body our filter sends must be exactly what Nest's own filter sends
  function assertSameResponseAsNest(exception: unknown, request: unknown = expressRequest) {
    const ours = fakeAdapter();
    const nest = fakeAdapter();
    new LoggingExceptionFilter(ours.adapter).catch(exception, httpHost(request));
    // Nest's filter logs unknown errors through its own static logger — keep
    // that out of the lines under test
    const silence = captureAll();
    new BaseExceptionFilter(nest.adapter).catch(exception, httpHost(request));
    silence.length = 0;
    assert.deepEqual(ours.replies, nest.replies);
    return ours.replies[0];
  }

  it('a plain Error: one error line with stack, context and route; generic 500 body', async () => {
    const lines = captureAll();
    const { adapter, replies } = fakeAdapter();
    await runWithLogContext({ correlationId: 'req-1', accountId: 42 }, async () => {
      new LoggingExceptionFilter(adapter).catch(new Error('db exploded'), httpHost(expressRequest));
    });
    assert.equal(lines.length, 1, 'exactly one line — Nest\'s own ExceptionsHandler line is suppressed');
    const [line] = lines;
    assert.equal(line.level, 50);
    assert.equal(line.event, 'http.unhandled_error');
    assert.equal(line.status, 500);
    assert.equal(line.route, '/orders/:id');
    assert.equal(line.correlationId, 'req-1');
    assert.equal(line.accountId, 42);
    assert.equal(line.err.message, 'db exploded');
    assert.match(line.err.stack, /db exploded/);
    assert.deepEqual(replies, [{ body: { statusCode: 500, message: 'Internal server error' }, status: 500 }]);
    assert.ok(!JSON.stringify(replies).includes('db exploded'), 'the client never sees the error');
  });

  it('matches Nest\'s response for unknown errors, HttpExceptions and http-errors', () => {
    captureAll();
    assertSameResponseAsNest(new Error('boom'));
    assertSameResponseAsNest(new NotFoundException());
    assertSameResponseAsNest(new BadRequestException(['email must be an email']));
    assertSameResponseAsNest(new InternalServerErrorException());
    const tooLarge = Object.assign(new Error('request entity too large'), { statusCode: 413 });
    assert.deepEqual(assertSameResponseAsNest(tooLarge), {
      body: { statusCode: 413, message: 'request entity too large' },
      status: 413,
    });
  });

  it('401/403/429 log at warn with the reason and no stack', () => {
    const lines = captureAll();
    const filter = new LoggingExceptionFilter(fakeAdapter().adapter);
    filter.catch(new UnauthorizedException(), httpHost(expressRequest));
    filter.catch(new ForbiddenException('Missing permission'), httpHost(expressRequest));
    assert.deepEqual(
      lines.map((line) => [line.level, line.event, line.status, line.reason, line.err]),
      [
        [40, 'http.request_rejected', 401, 'Unauthorized', undefined],
        [40, 'http.request_rejected', 403, 'Missing permission', undefined],
      ],
    );
  });

  it('other 4xx (validation, not found, http-errors) log at debug', () => {
    const lines = captureAll();
    const filter = new LoggingExceptionFilter(fakeAdapter().adapter);
    filter.catch(new NotFoundException(), httpHost(expressRequest));
    filter.catch(Object.assign(new Error('too large'), { statusCode: 413 }), httpHost(expressRequest));
    assert.deepEqual(lines.map((line) => [line.level, line.status]), [[20, 404], [20, 413]]);
  });

  it('a thrown 5xx HttpException logs at error', () => {
    const lines = captureAll();
    new LoggingExceptionFilter(fakeAdapter().adapter).catch(
      new InternalServerErrorException(),
      httpHost(expressRequest),
    );
    assert.equal(lines[0].level, 50);
    assert.equal(lines[0].event, 'http.unhandled_error');
  });

  it('reads the route template off a Fastify request\'s raw Node request', () => {
    const lines = captureAll();
    const raw = { method: 'POST' } as IncomingMessage;
    setRequestRoute(raw, '/webhooks/stripe');
    new LoggingExceptionFilter(fakeAdapter().adapter).catch(new Error('x'), httpHost({ raw }));
    assert.equal(lines[0].route, '/webhooks/stripe');
  });
});

// Process-level behaviour needs a real process: run a tiny script against this
// module in a child and read what it wrote to stdout.
describe('process handlers', () => {
  const indexPath = fileURLToPath(new URL('./index.ts', import.meta.url));

  function runScript(
    body: string,
    onLine?: (line: Record<string, any>, child: ReturnType<typeof spawn>) => void,
  ): Promise<{ code: number | null; lines: Record<string, any>[] }> {
    const script = `
      import * as logging from ${JSON.stringify(indexPath)};
      logging.configureLogging({ service: 'test', nodeEnv: 'production' });
      ${body}
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, NODE_ENV: 'production' },
    });
    const lines: Record<string, any>[] = [];
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        lines.push(line);
        onLine?.(line, child);
      }
    });
    return new Promise((resolve) => child.on('close', (code) => resolve({ code, lines })));
  }

  it('an unhandled rejection logs one fatal line and exits 1', async () => {
    const { code, lines } = await runScript(`
      logging.installProcessHandlers();
      Promise.reject(new Error('nobody caught me'));
    `);
    assert.equal(code, 1);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, 60);
    assert.equal(lines[0].event, 'process.unhandled_rejection');
    assert.equal(lines[0].err.message, 'nobody caught me');
  });

  it('an uncaught exception logs one fatal line and exits 1', async () => {
    const { code, lines } = await runScript(`
      logging.installProcessHandlers();
      setTimeout(() => { throw new Error('thrown in a timer'); }, 0);
    `);
    assert.equal(code, 1);
    assert.deepEqual(lines.map((line) => [line.level, line.event]), [[60, 'process.uncaught_exception']]);
  });

  it('a failed bootstrap logs app.boot_failed and exits 1', async () => {
    const { code, lines } = await runScript(`
      async function bootstrap() { throw new Error('redis unreachable'); }
      bootstrap().catch((err) => logging.exitOnFatal(err, 'app.boot_failed'));
    `);
    assert.equal(code, 1);
    assert.equal(lines[0].event, 'app.boot_failed');
    assert.equal(lines[0].err.message, 'redis unreachable');
  });

  it('SIGTERM closes the app, flushes and exits 0', async () => {
    const { code, lines } = await runScript(
      `
      const logger = new logging.Logger('App');
      logging.installShutdownHandler({
        close: async () => { logger.info({ event: 'app.closed' }, 'closed'); },
      });
      setInterval(() => undefined, 1000);
      logger.info({ event: 'app.ready' }, 'ready');
    `,
      (line, child) => {
        if (line.event === 'app.ready') child.kill('SIGTERM');
      },
    );
    assert.equal(code, 0);
    assert.deepEqual(
      lines.map((line) => line.event),
      ['app.ready', 'process.shutdown_started', 'app.closed'],
    );
  });
});
