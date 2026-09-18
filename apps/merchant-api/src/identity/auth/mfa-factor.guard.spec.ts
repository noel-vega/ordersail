import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IS_PUBLIC_KEY,
  NO_MFA_FACTOR_REQUIRED_KEY,
  REQUIRE_MFA_FACTOR_KEY,
  type AuthenticatedRequest,
} from 'src/shared/auth/decorators';
import { MfaFactorGuard } from './mfa-factor.guard';
import { AuthService } from './auth.service';
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

// The guard reads factor state live rather than trusting the token, so this
// stub is "what the database currently says" — deliberately separate from
// the claim on the fake users below, because the whole point is that the two
// can disagree.
function guard(holdsFactor = true) {
  const authService = {
    getFactorState: jest.fn().mockResolvedValue({
      totpConfirmed: holdsFactor,
      passkeyCount: 0,
      hasMfaFactor: holdsFactor,
    }),
  } as unknown as AuthService;
  return new MfaFactorGuard(new Reflector(), authService);
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
  it('allows a route with no marker', async () => {
    await expect(
      guard(false).canActivate(ctx({ user: withoutFactor })),
    ).resolves.toBe(true);
  });

  it('allows a marked route when the caller holds a factor', async () => {
    await expect(
      guard(true).canActivate(ctx({ required: true, user: withFactor })),
    ).resolves.toBe(true);
  });

  it('blocks a marked route when the caller holds none', async () => {
    await expect(
      guard(false).canActivate(ctx({ required: true, user: withoutFactor })),
    ).rejects.toThrow(ForbiddenException);
  });

  // The claim is baked in at mint time and keeps asserting itself for 8h.
  // Someone who removes their last factor mid-session still carries `true`,
  // so trusting the token would leave them authorized for a gated action
  // while holding no factor at all.
  it('blocks when the token claims a factor the user no longer holds', async () => {
    await expect(
      guard(false).canActivate(ctx({ required: true, user: withFactor })),
    ).rejects.toThrow(ForbiddenException);
  });

  // The mirror image: enrolling mid-session works straight away, instead of
  // failing every gated action until the next token refresh.
  it('allows when the user enrolled after the token was minted', async () => {
    await expect(
      guard(true).canActivate(ctx({ required: true, user: withoutFactor })),
    ).resolves.toBe(true);
  });

  // merchant-web branches on this to offer setting a factor up; a message
  // alone could only be matched by string comparison
  it('carries a machine-readable code', async () => {
    const err = await guard(false)
      .canActivate(ctx({ required: true, user: withoutFactor }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({
      code: 'MFA_FACTOR_REQUIRED',
    });
  });

  it('allows a public route regardless', async () => {
    await expect(
      guard(false).canActivate(
        ctx({ isPublic: true, required: true, user: undefined }),
      ),
    ).resolves.toBe(true);
  });

  // the normal shape: a controller marked "no factor needed" with one
  // handler that does need one. The handler has to win, or gating a single
  // route on an otherwise ordinary controller silently does nothing.
  it('lets a handler-level requirement beat the class-level opt-out', async () => {
    await expect(
      guard(false).canActivate(
        ctx({ required: true, classNotRequired: true, user: withoutFactor }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('honours a class-level requirement', async () => {
    await expect(
      guard(false).canActivate(
        ctx({ classRequired: true, user: withoutFactor }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  // A missing user means an earlier guard should already have rejected this,
  // but the gate must not read that as "no factor needed".
  it('blocks a marked route with no user at all', async () => {
    await expect(
      guard(true).canActivate(ctx({ required: true, user: undefined })),
    ).rejects.toThrow(ForbiddenException);
  });

  // the live lookup is the price of a gated route, not of every request
  it('does not query factor state for an ungated route', async () => {
    const getFactorState = jest.fn();
    const authService = { getFactorState } as unknown as AuthService;

    await new MfaFactorGuard(new Reflector(), authService).canActivate(
      ctx({ user: withoutFactor }),
    );

    expect(getFactorState).not.toHaveBeenCalled();
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
