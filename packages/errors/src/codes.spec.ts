import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  codes,
  docUrl,
  genericCodeForStatus,
  genericCodes,
  isErrorCode,
  typeForStatus,
  detailsSchemas,
  type DetailsByCode,
  type ErrorCode,
} from './codes.ts';
import type { FromSchema } from 'json-schema-to-ts';

const STATUSES = [400, 401, 403, 404, 405, 406, 408, 409, 410, 412, 413, 415, 421, 422, 429, 500, 501, 502, 503, 504, 505];

describe('the code registry', () => {
  it('has a generic code for exactly the fixed set of 21 statuses', () => {
    assert.deepEqual(Object.keys(genericCodes).map(Number), STATUSES);
  });

  it('never shares a generic code between two statuses', () => {
    const generic = Object.values(genericCodes);
    assert.equal(new Set(generic).size, generic.length);
  });

  it('names generic codes after the RFC 9110 reason phrase, except 401/429/500', () => {
    assert.equal(genericCodes[413], 'content_too_large');
    assert.equal(genericCodes[421], 'misdirected_request');
    assert.equal(genericCodes[422], 'unprocessable_content');
    assert.equal(genericCodes[401], 'unauthenticated');
    assert.equal(genericCodes[429], 'rate_limited');
    assert.equal(genericCodes[500], 'internal_error');
  });

  it("gives each generic code its own status", () => {
    for (const [status, code] of Object.entries(genericCodes)) assert.equal(codes[code].status, Number(status));
  });

  it('falls back to bad_request / internal_error for a status outside the set', () => {
    assert.equal(genericCodeForStatus(418), 'bad_request');
    assert.equal(genericCodeForStatus(507), 'internal_error');
  });

  it('derives every type from the status, with catch-alls for 4xx and 5xx', () => {
    assert.equal(typeForStatus(401), 'authentication_error');
    assert.equal(typeForStatus(403), 'permission_error');
    assert.equal(typeForStatus(429), 'rate_limit_error');
    assert.equal(typeForStatus(404), 'invalid_request_error');
    assert.equal(typeForStatus(418), 'invalid_request_error');
    assert.equal(typeForStatus(503), 'api_error');
    assert.equal(typeForStatus(599), 'api_error');
  });

  it("stores each entry's type consistently with its status", () => {
    for (const [code, entry] of Object.entries(codes)) assert.equal(entry.type, typeForStatus(entry.status), code);
  });

  it('uses snake_case codes and kebab-case doc URLs', () => {
    for (const code of Object.keys(codes) as ErrorCode[]) {
      assert.match(code, /^[a-z]+(_[a-z]+)*$/);
      assert.equal(docUrl(code), `https://ordersail.com/docs/errors/${code.replaceAll('_', '-')}`);
    }
    assert.equal(docUrl('insufficient_stock' as ErrorCode), 'https://ordersail.com/docs/errors/insufficient-stock');
  });

  it('recognises only registered codes', () => {
    assert.ok(isErrorCode('mfa_factor_required'));
    assert.ok(!isErrorCode('MFA_FACTOR_REQUIRED'));
    assert.ok(!isErrorCode('toString'));
  });
});

// Compile-time drift check: each detailsSchemas schema (what the OpenAPI
// document publishes, and so what the SDKs type `details` as) must describe
// exactly its DetailsByCode type (what the throwers check against). A mismatch
// fails typecheck here and names the drifting code.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Schemas = typeof detailsSchemas;
// `true` only when A and B are exactly the same type; the value is never read.
function same<A, B>(): Equal<A, B> {
  return true as never;
}
// one entry per code (the `satisfies` makes a new code add one); an entry that
// isn't `true` is the code whose schema and type have drifted apart
void ({
  validation_failed: same<
    FromSchema<Schemas['validation_failed']['schema']>,
    DetailsByCode['validation_failed']
  >(),
  service_unavailable: same<
    FromSchema<Schemas['service_unavailable']['schema']>,
    Exclude<DetailsByCode['service_unavailable'], undefined>
  >(),
} satisfies Record<keyof Schemas, true>);
