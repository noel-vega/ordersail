import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IS_PUBLIC_KEY,
  SKIP_EMAIL_VERIFICATION_KEY,
  type AuthenticatedRequest,
} from 'src/shared/auth/decorators';
import { EmailVerifiedGuard } from './email-verified.guard';

// a minimal ExecutionContext carrying route metadata + a fake request —
// same shape as permissions.guard.spec.ts's ctx() helper
function ctx(opts: {
  isPublic?: boolean;
  skip?: boolean;
  user?: AuthenticatedRequest['user'];
}): ExecutionContext {
  const handler = () => undefined;
  if (opts.isPublic) Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
  if (opts.skip) {
    Reflect.defineMetadata(SKIP_EMAIL_VERIFICATION_KEY, true, handler);
  }

  const request: AuthenticatedRequest = { user: opts.user };
  return {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function guard() {
  return new EmailVerifiedGuard(new Reflector());
}

const unverifiedUser: AuthenticatedRequest['user'] = {
  sub: 1,
  accountId: 1,
  emailVerified: false,
  mfaEnrollmentSatisfied: true,
  typ: 'access',
};

const verifiedUser: AuthenticatedRequest['user'] = {
  ...unverifiedUser,
  emailVerified: true,
};

describe('EmailVerifiedGuard (OS-470)', () => {
  it('allows a @Public() route regardless of verification status', () => {
    expect(
      guard().canActivate(ctx({ isPublic: true, user: unverifiedUser })),
    ).toBe(true);
  });

  it('allows a @Public() route with no user at all', () => {
    expect(guard().canActivate(ctx({ isPublic: true }))).toBe(true);
  });

  it('allows a @SkipEmailVerification() route for an unverified user', () => {
    expect(guard().canActivate(ctx({ skip: true, user: unverifiedUser }))).toBe(
      true,
    );
  });

  it('blocks a gated route for an unverified user', () => {
    expect(() => guard().canActivate(ctx({ user: unverifiedUser }))).toThrow(
      ForbiddenException,
    );
  });

  it('allows a gated route for a verified user', () => {
    expect(guard().canActivate(ctx({ user: verifiedUser }))).toBe(true);
  });

  it('blocks a gated route with no user at all (not @Public(), not @SkipEmailVerification())', () => {
    expect(() => guard().canActivate(ctx({}))).toThrow(ForbiddenException);
  });
});
