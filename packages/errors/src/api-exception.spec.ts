import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { HttpException } from '@nestjs/common';
import { ApiException } from './api-exception.ts';

describe('ApiException', () => {
  it('takes its status from the registry and is an HttpException', () => {
    const exception = new ApiException('invalid_credentials');
    assert.ok(exception instanceof HttpException);
    assert.equal(exception.getStatus(), 401);
    assert.equal(exception.code, 'invalid_credentials');
    assert.equal(exception.message, 'The email or password is incorrect.');
  });

  it('a custom message replaces the default', () => {
    assert.equal(new ApiException('not_found', { message: 'No such product' }).message, 'No such product');
  });

  it('type-checks details against the code', () => {
    new ApiException('validation_failed', { details: { fields: [] } });
    new ApiException('service_unavailable');
    new ApiException('service_unavailable', { details: { database: 'down' } });
    // @ts-expect-error validation_failed requires details
    new ApiException('validation_failed');
    // @ts-expect-error a code without a details shape takes none
    new ApiException('not_found', { details: { id: 1 } });
    // @ts-expect-error details must match the code's shape
    new ApiException('service_unavailable', { details: { database: 'sideways' } });
  });
});
