import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  configureLogging,
  getCorrelationId,
  Logger,
  maskEmail,
  normalizeLogArgs,
  runWithCorrelationId,
} from './index.ts';

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

describe('correlation context', () => {
  it('is visible across awaits inside the scope and absent outside', async () => {
    assert.equal(getCorrelationId(), undefined);
    await runWithCorrelationId('abc', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      assert.equal(getCorrelationId(), 'abc');
    });
    assert.equal(getCorrelationId(), undefined);
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
