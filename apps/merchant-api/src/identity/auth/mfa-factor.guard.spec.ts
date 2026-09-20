import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IS_PUBLIC_KEY,
  NO_MFA_FACTOR_REQUIRED_KEY,
  REQUIRE_MFA_FACTOR_KEY,
  type AuthenticatedRequest,
} from 'src/shared/auth/decorators';
import { MfaFactorGuard } from './mfa-factor.guard';
import { FactorStateService } from './factor-state.service';
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

// The guard reads factor state live — the token carries no factor claim at
// all (OS-505) — so this stub is "what the database currently says", and it
// is the only thing that decides the outcome.
function guard(holdsFactor = true) {
  const factorState = {
    getFactorState: jest.fn().mockResolvedValue({
      totpConfirmed: holdsFactor,
      passkeyCount: 0,
      hasMfaFactor: holdsFactor,
    }),
  } as unknown as FactorStateService;
  return new MfaFactorGuard(new Reflector(), factorState);
}

const caller = {
  sub: 1,
  accountId: 1,
  emailVerified: true,
  mfaEnrollmentSatisfied: true,
  typ: 'access',
} as const satisfies AuthenticatedRequest['user'];

describe('MfaFactorGuard (OS-492)', () => {
  // allow-by-default, unlike MfaEnrollmentGuard — most routes are ordinary
  it('allows a route with no marker', async () => {
    await expect(guard(false).canActivate(ctx({ user: caller }))).resolves.toBe(
      true,
    );
  });

  // The same token on both sides of these two: nothing minted into it can
  // vouch for a factor, so enrolling mid-session works straight away, and
  // someone who removes their last factor mid-session is blocked on the very
  // next gated action rather than staying authorized until the token expires.
  it('allows a marked route when the caller holds a factor', async () => {
    await expect(
      guard(true).canActivate(ctx({ required: true, user: caller })),
    ).resolves.toBe(true);
  });

  it('blocks a marked route when the caller holds none', async () => {
    await expect(
      guard(false).canActivate(ctx({ required: true, user: caller })),
    ).rejects.toThrow(ForbiddenException);
  });

  // merchant-web branches on this to offer setting a factor up; a message
  // alone could only be matched by string comparison
  it('carries a machine-readable code', async () => {
    const err = await guard(false)
      .canActivate(ctx({ required: true, user: caller }))
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
        ctx({ required: true, classNotRequired: true, user: caller }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('honours a class-level requirement', async () => {
    await expect(
      guard(false).canActivate(ctx({ classRequired: true, user: caller })),
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
    const factorState = { getFactorState } as unknown as FactorStateService;

    await new MfaFactorGuard(new Reflector(), factorState).canActivate(
      ctx({ user: caller }),
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
