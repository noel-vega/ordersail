import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import Fastify, { type InjectOptions } from 'fastify';
import { ApiException } from './api-exception.ts';
import { toErrorEnvelope } from './envelope.ts';

const REQUEST_ID = 'req-1';

function envelope(exception: unknown) {
  return toErrorEnvelope(exception, REQUEST_ID);
}

describe('toErrorEnvelope', () => {
  it('an ApiException answers with its registry entry', () => {
    const { status, body } = envelope(new ApiException('email_taken', { param: 'email' }));
    assert.equal(status, 409);
    assert.deepEqual(body, {
      error: {
        type: 'invalid_request_error',
        code: 'email_taken',
        message: 'An account with this email already exists.',
        param: 'email',
        doc_url: 'https://ordersail.com/docs/errors/email-taken',
        request_id: REQUEST_ID,
      },
    });
  });

  it('an ApiException keeps its message and details', () => {
    const fields = [{ param: 'email', message: 'email must be an email' }];
    const { body } = envelope(
      new ApiException('validation_failed', { message: 'email must be an email', param: 'email', details: { fields } }),
    );
    assert.equal(body.error.message, 'email must be an email');
    assert.deepEqual(body.error.details, { fields });
  });

  it('a plain NotFoundException gets the generic code and keeps its message', () => {
    const { status, body } = envelope(new NotFoundException('Product not found'));
    assert.equal(status, 404);
    assert.equal(body.error.code, 'not_found');
    assert.equal(body.error.type, 'invalid_request_error');
    assert.equal(body.error.message, 'Product not found');
    assert.ok(!('param' in body.error));
    assert.ok(!('details' in body.error));
  });

  it('a payload code is kept when the registry has it, snake_cased', () => {
    const { body } = envelope(
      new ForbiddenException({ message: 'A passkey is required', code: 'MFA_FACTOR_REQUIRED' }),
    );
    assert.equal(body.error.code, 'mfa_factor_required');
    assert.equal(body.error.message, 'A passkey is required');
  });

  it('an unregistered payload code falls back to the generic code', () => {
    const { body } = envelope(new ForbiddenException({ message: 'Nope', code: 'EMAIL_NOT_VERIFIED' }));
    assert.equal(body.error.code, 'forbidden');
  });

  it("a registered payload code for a different status falls back too, so code and status agree", () => {
    const { status, body } = envelope(new BadRequestException({ message: 'x', code: 'email_taken' }));
    assert.equal(status, 400);
    assert.equal(body.error.code, 'bad_request');
  });

  it("BadRequestException(string[]) joins the messages", () => {
    const { body } = envelope(new BadRequestException(['email must be an email', 'name should not be empty']));
    assert.equal(body.error.code, 'bad_request');
    assert.equal(body.error.message, 'email must be an email, name should not be empty');
  });

  // The error Fastify itself raises for a request, before any handler runs —
  // captured from a real instance rather than hand-built, so the fixture has
  // the shape the filter will actually see.
  async function fastifyErrorFor(request: InjectOptions, options: { bodyLimit?: number } = {}): Promise<unknown> {
    const app = Fastify(options);
    let captured: unknown;
    app.setErrorHandler((error, _request, reply) => {
      captured = error;
      return reply.send();
    });
    app.post('/', async () => 'ok');
    try {
      await app.inject({ method: 'POST', url: '/', ...request });
    } finally {
      await app.close();
    }
    assert.ok(captured, 'Fastify raised no error');
    return captured;
  }

  it("Fastify's malformed-JSON 400 keeps its status", async () => {
    const parse = await fastifyErrorFor({ headers: { 'content-type': 'application/json' }, payload: '{"a":' });
    assert.equal(envelope(parse).status, 400);
    assert.equal(envelope(parse).body.error.code, 'bad_request');
  });

  it("Fastify's 413 / 415 get their generic codes and keep Fastify's message", async () => {
    const tooLarge = await fastifyErrorFor(
      { headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ name: 'x'.repeat(100) }) },
      { bodyLimit: 10 },
    );
    assert.deepEqual(
      [envelope(tooLarge).status, envelope(tooLarge).body.error.code, envelope(tooLarge).body.error.message],
      [413, 'content_too_large', (tooLarge as Error).message],
    );
    const mediaType = await fastifyErrorFor({ headers: { 'content-type': 'text/xml' }, payload: '<a/>' });
    assert.equal(envelope(mediaType).status, 415);
    assert.equal(envelope(mediaType).body.error.code, 'unsupported_media_type');
  });

  it("an http-errors `expose` flag alone isn't trusted — no Express body parser left to raise one", () => {
    const exposed = Object.assign(new Error('raw library message'), { statusCode: 400, expose: true });
    assert.equal(envelope(exposed).status, 500);
    assert.equal(envelope(exposed).body.error.code, 'internal_error');
  });

  it("a ThrottlerException is rate_limited, with the registry's message rather than the class name", () => {
    const { status, body } = envelope(new ThrottlerException());
    assert.equal(status, 429);
    assert.equal(body.error.code, 'rate_limited');
    assert.equal(body.error.type, 'rate_limit_error');
    assert.equal(body.error.message, 'Too many requests. Try again later.');
  });

  it("a library error with a statusCode (Stripe's) is a generic 500, not its status and raw message", () => {
    // the shape stripe-node's StripeCardError carries: statusCode, code, a raw message
    const stripeError = Object.assign(new Error('Your card was declined. (req_abc123, acct_1Xyz)'), {
      type: 'StripeCardError',
      statusCode: 402,
      code: 'card_declined',
    });
    const { status, body } = envelope(stripeError);
    assert.equal(status, 500);
    assert.equal(body.error.code, 'internal_error');
    assert.ok(!JSON.stringify(body).includes('declined'));
  });

  it("a Terminus 503 reports up/down per check and none of the checks' error text", () => {
    const { status, body } = envelope(
      new ServiceUnavailableException({
        status: 'error',
        info: { redis: { status: 'up' } },
        error: { database: { status: 'down', message: 'connect ECONNREFUSED 10.0.3.12:5432' } },
        details: {
          database: { status: 'down', message: 'connect ECONNREFUSED 10.0.3.12:5432' },
          redis: { status: 'up' },
        },
      }),
    );
    assert.equal(status, 503);
    assert.equal(body.error.code, 'service_unavailable');
    assert.equal(body.error.message, 'The service is temporarily unavailable.');
    assert.deepEqual(body.error.details, { database: 'down', redis: 'up' });
    assert.ok(!JSON.stringify(body).includes('ECONNREFUSED'));
  });

  it('an unknown Error is a generic 500', () => {
    const { status, body } = envelope(new Error('db exploded'));
    assert.equal(status, 500);
    assert.equal(body.error.code, 'internal_error');
    assert.equal(body.error.type, 'api_error');
    assert.equal(body.error.message, 'Something went wrong on our end.');
  });

  it('a 5xx body never carries the thrown message, stack or cause', () => {
    const cause = new Error('upstream secret');
    const thrown = [
      new Error('db exploded', { cause }),
      new InternalServerErrorException('db exploded', { cause }),
      new ServiceUnavailableException('db exploded'),
      new ApiException('bad_gateway', { message: 'db exploded' }),
      Object.assign(new Error('db exploded'), { statusCode: 502 }),
      'db exploded',
    ];
    for (const exception of thrown) {
      const text = JSON.stringify(envelope(exception).body);
      assert.ok(!text.includes('db exploded'), text);
      assert.ok(!text.includes('upstream secret'), text);
      assert.ok(!text.includes('stack'), text);
    }
  });

  it('a status outside the fixed set keeps its status and gets the fallback code', () => {
    const { status, body } = envelope(new HttpException("I'm a teapot", 418));
    assert.equal(status, 418);
    assert.equal(body.error.code, 'bad_request');
    assert.equal(body.error.type, 'invalid_request_error');
  });

  it('request_id is the given ID, or null outside a request', () => {
    assert.equal(envelope(new NotFoundException()).body.error.request_id, REQUEST_ID);
    assert.equal(toErrorEnvelope(new NotFoundException(), undefined).body.error.request_id, null);
  });
});
