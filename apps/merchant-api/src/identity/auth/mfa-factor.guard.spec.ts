import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IS_PUBLIC_KEY,
  NO_MFA_FACTOR_REQUIRED_KEY,
  REQUIRE_MFA_FACTOR_KEY,
  type AuthenticatedRequest,
} from 'src/shared/auth/decorators';
import { MfaFactorGuard } from './mfa-factor.guard';
import { AuthModule } from './auth.module';

// same ctx() shape as mfa-enrollment.guard.spec.ts, plus a class-level
// marker, since that's how the opt-out is applied in practice
function ctx(opts: {
  isPublic?: boolean;
  required?: boolean;
  classRequired?: boolean;
  classNotRequired?: boolean;
  user?: AuthenticatedRequest['user'];
}): ExecutionContext {
  const handler = () => undefined;
  if (opts.isPublic) Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
  if (opts.required) {
    Reflect.defineMetadata(REQUIRE_MFA_FACTOR_KEY, true, handler);
  }

  class Controller {}
  if (opts.classRequired) {
    Reflect.defineMetadata(REQUIRE_MFA_FACTOR_KEY, true, Controller);
  }
  if (opts.classNotRequired) {
    Reflect.defineMetadata(NO_MFA_FACTOR_REQUIRED_KEY, true, Controller);
  }

  const request: AuthenticatedRequest = { user: opts.user };
  return {
    getHandler: () => handler,
    getClass: () => Controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function guard() {
  return new MfaFactorGuard(new Reflector());
}

const withFactor = {
  sub: 1,
  email: 'staff@store.test',
  accountId: 1,
  firstName: 'Staff',
  lastName: 'Member',
  emailVerified: true,
  mfaEnrollmentSatisfied: true,
  hasMfaFactor: true,
  typ: 'access',
} as const satisfies AuthenticatedRequest['user'];

const withoutFactor = { ...withFactor, hasMfaFactor: false };

describe('MfaFactorGuard (OS-492)', () => {
  // allow-by-default, unlike MfaEnrollmentGuard — most routes are ordinary
  it('allows a route with no marker', () => {
    expect(guard().canActivate(ctx({ user: withoutFactor }))).toBe(true);
  });

  it('allows a marked route when the caller holds a factor', () => {
    expect(guard().canActivate(ctx({ required: true, user: withFactor }))).toBe(
      true,
    );
  });

  it('blocks a marked route when the caller holds none', () => {
    expect(() =>
      guard().canActivate(ctx({ required: true, user: withoutFactor })),
    ).toThrow(ForbiddenException);
  });

  // merchant-web branches on this to offer setting a factor up; a message
  // alone could only be matched by string comparison
  it('carries a machine-readable code', () => {
    try {
      guard().canActivate(ctx({ required: true, user: withoutFactor }));
      throw new Error('expected the guard to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        code: 'MFA_FACTOR_REQUIRED',
      });
    }
  });

  it('allows a public route regardless', () => {
    expect(
      guard().canActivate(
        ctx({ isPublic: true, required: true, user: undefined }),
      ),
    ).toBe(true);
  });

  // the normal shape: a controller marked "no factor needed" with one
  // handler that does need one. The handler has to win, or gating a single
  // route on an otherwise ordinary controller silently does nothing.
  it('lets a handler-level requirement beat the class-level opt-out', () => {
    expect(() =>
      guard().canActivate(
        ctx({ required: true, classNotRequired: true, user: withoutFactor }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('honours a class-level requirement', () => {
    expect(() =>
      guard().canActivate(ctx({ classRequired: true, user: withoutFactor })),
    ).toThrow(ForbiddenException);
  });

  // A missing user means an earlier guard should already have rejected this,
  // but the gate must not read that as "no factor needed".
  it('blocks a marked route with no user at all', () => {
    expect(() =>
      guard().canActivate(ctx({ required: true, user: undefined })),
    ).toThrow(ForbiddenException);
  });
});

describe('global guard order (OS-492)', () => {
  // Load-bearing: someone who lacks the permission entirely should be told
  // that, not asked to add a passkey for an action they could never perform.
  // Nest runs APP_GUARD providers in registration order.
  it('registers the factor gate after the permissions guard', () => {
    const providers = Reflect.getMetadata('providers', AuthModule) as {
      useClass?: { name: string };
    }[];
    const names = providers.map((p) => p.useClass?.name).filter(Boolean);

    expect(names.indexOf('MfaFactorGuard')).toBeGreaterThan(
      names.indexOf('PermissionsGuard'),
    );
  });
});
