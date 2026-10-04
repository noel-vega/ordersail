import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ValidationError } from 'class-validator';
import { toErrorEnvelope } from './envelope.ts';
import { validationExceptionFactory } from './validation.ts';

function failure(property: string, constraints?: Record<string, string>, children: ValidationError[] = []) {
  return Object.assign(new ValidationError(), { property, constraints, children });
}

describe('validationExceptionFactory', () => {
  it('describes the first failure in param/message and lists every failure in details.fields', () => {
    const exception = validationExceptionFactory([
      failure('email', { isEmail: 'email must be an email' }),
      failure('name', { isNotEmpty: 'name should not be empty', isString: 'name must be a string' }),
    ]);
    const { status, body } = toErrorEnvelope(exception, 'req-1');
    assert.equal(status, 400);
    assert.equal(body.error.code, 'validation_failed');
    assert.equal(body.error.param, 'email');
    assert.equal(body.error.message, 'email must be an email');
    assert.deepEqual(body.error.details, {
      fields: [
        { param: 'email', message: 'email must be an email' },
        { param: 'name', message: 'name should not be empty' },
        { param: 'name', message: 'name must be a string' },
      ],
    });
  });

  it('flattens nested properties into dotted paths', () => {
    const exception = validationExceptionFactory([
      failure('shippingDetails', undefined, [
        failure('address', undefined, [failure('postal_code', { isPostalCode: 'postal_code must be a postal code' })]),
      ]),
      failure('items', undefined, [failure('0', undefined, [failure('sku', { isString: 'sku must be a string' })])]),
    ]);
    assert.equal(exception.param, 'shippingDetails.address.postal_code');
    assert.deepEqual(exception.details, {
      fields: [
        { param: 'shippingDetails.address.postal_code', message: 'postal_code must be a postal code' },
        { param: 'items.0.sku', message: 'sku must be a string' },
      ],
    });
  });
});
