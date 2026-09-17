import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { getCorrelationId, normalizeLogArgs, runWithCorrelationId } from './index.ts';

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

  it('non-Error, non-string extras land in detail', () => {
    assert.deepEqual(normalizeLogArgs('Svc', 'odd rejection', [{ code: 42 }]), [
      { context: 'Svc', detail: { code: 42 } },
      'odd rejection',
    ]);
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
