import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IS_PUBLIC_KEY,
  SKIP_MFA_ENROLLMENT_KEY,
  type AuthenticatedRequest,
} from 'src/shared/auth/decorators';
import { MfaEnrollmentGuard } from './mfa-enrollment.guard';
import { EmailVerifiedGuard } from './email-verified.guard';
import { AuthController } from './auth.controller';

// same shape as email-verified.guard.spec.ts's ctx() helper
function ctx(opts: {
  isPublic?: boolean;
  skip?: boolean;
  user?: AuthenticatedRequest['user'];
}): ExecutionContext {
  const handler = () => undefined;
  if (opts.isPublic) Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
  if (opts.skip) {
    Reflect.defineMetadata(SKIP_MFA_ENROLLMENT_KEY, true, handler);
  }

  const request: AuthenticatedRequest = { user: opts.user };
  return {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function guard() {
  return new MfaEnrollmentGuard(new Reflector());
}

const unsatisfiedUser: AuthenticatedRequest['user'] = {
  sub: 1,
  email: 'x@store.test',
  accountId: 1,
  firstName: 'X',
  lastName: 'Y',
  emailVerified: true,
  mfaEnrollmentSatisfied: false,
  hasMfaFactor: false,
  typ: 'access',
};

const satisfiedUser: AuthenticatedRequest['user'] = {
  ...unsatisfiedUser,
  mfaEnrollmentSatisfied: true,
  hasMfaFactor: false,
};

describe('MfaEnrollmentGuard (OS-473)', () => {
  it('allows a @Public() route regardless of enrollment status', () => {
    expect(
      guard().canActivate(ctx({ isPublic: true, user: unsatisfiedUser })),
    ).toBe(true);
  });

  it('allows a @Public() route with no user at all', () => {
    expect(guard().canActivate(ctx({ isPublic: true }))).toBe(true);
  });

  it('allows a @SkipMfaEnrollment() route for an unenrolled user', () => {
    expect(
      guard().canActivate(ctx({ skip: true, user: unsatisfiedUser })),
    ).toBe(true);
  });

  it('blocks a gated route when enrollment is required and unsatisfied', () => {
    expect(() => guard().canActivate(ctx({ user: unsatisfiedUser }))).toThrow(
      ForbiddenException,
    );
  });

  it('allows a gated route when enrollment is satisfied', () => {
    expect(guard().canActivate(ctx({ user: satisfiedUser }))).toBe(true);
  });

  it('blocks a gated route with no user at all (not @Public(), not @SkipMfaEnrollment())', () => {
    expect(() => guard().canActivate(ctx({}))).toThrow(ForbiddenException);
  });
});

// enrollMfa() requires a verified email, so a user who is both unverified
// and MFA-gated can only get unstuck if the email-verification routes clear
// both guards — otherwise neither gate can ever be satisfied
describe.each(['resendVerification', 'verifyEmail'])(
  'AuthController.%s reachable while email- and MFA-gated',
  (method) => {
    const stuckUser: AuthenticatedRequest['user'] = {
      ...unsatisfiedUser,
      emailVerified: false,
    };

    function realCtx(): ExecutionContext {
      const request: AuthenticatedRequest = { user: stuckUser };
      const handler: unknown = Object.getOwnPropertyDescriptor(
        AuthController.prototype,
        method,
      )?.value;
      expect(handler).toBeDefined();
      return {
        getHandler: () => handler,
        getClass: () => AuthController,
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;
    }

    it('passes EmailVerifiedGuard', () => {
      expect(
        new EmailVerifiedGuard(new Reflector()).canActivate(realCtx()),
      ).toBe(true);
    });

    it('passes MfaEnrollmentGuard', () => {
      expect(guard().canActivate(realCtx())).toBe(true);
    });
  },
);
