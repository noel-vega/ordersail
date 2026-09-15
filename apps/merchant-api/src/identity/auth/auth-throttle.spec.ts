import { Reflector } from '@nestjs/core';
import { AuthController } from './auth.controller';

// OS-314 — signin/signup/accept-invite carry tighter-than-global-default
// throttle buckets so brute-force/spam attempts are rejected before the
// 100/min global bucket would ever kick in.
//
// @nestjs/throttler's THROTTLER_LIMIT/THROTTLER_TTL constants aren't
// re-exported from its public entrypoint, so the literal metadata keys
// (name + throttler name, no separator — see @Throttle's implementation)
// are reproduced here instead of reaching into its dist internals.
const THROTTLER_LIMIT_DEFAULT = 'THROTTLER:LIMITdefault';
const THROTTLER_TTL_DEFAULT = 'THROTTLER:TTLdefault';

const reflector = new Reflector();
const controller = AuthController.prototype as unknown as Record<
  string,
  () => unknown
>;
const throttle = (method: string): { limit?: number; ttl?: number } => ({
  limit: reflector.get(THROTTLER_LIMIT_DEFAULT, controller[method]),
  ttl: reflector.get(THROTTLER_TTL_DEFAULT, controller[method]),
});

describe('auth throttle buckets (OS-314)', () => {
  it('gates signin at 10/min', () => {
    expect(throttle('signin')).toEqual({ limit: 10, ttl: 60_000 });
  });

  it('gates signup at 5/min', () => {
    expect(throttle('signup')).toEqual({ limit: 5, ttl: 60_000 });
  });

  it('gates accept-invite at 5/min', () => {
    expect(throttle('acceptInvite')).toEqual({ limit: 5, ttl: 60_000 });
  });
});
