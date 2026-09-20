import { type ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { eq, userRefreshTokensTable } from 'db/identity';
import { lockWaiters, type TestDb } from 'test-support';
import {
  SKIP_EMAIL_VERIFICATION_KEY,
  SKIP_MFA_ENROLLMENT_KEY,
  type AuthenticatedUser,
} from 'src/shared/auth/decorators';
import { AuthGuard } from './auth.guard';
import { EmailVerifiedGuard } from './email-verified.guard';
import { MfaEnrollmentGuard } from './mfa-enrollment.guard';
import { type SessionsService, type TokenPair } from './sessions.service';

// Shared by the specs at the two Session seams — the sign-in operations
// (auth.service.spec, passkeys.service.spec) and SessionsService itself
// (sessions.service.spec) — and by users/users.service.spec, where
// deactivating a User ends their Sessions. Spec-only: excluded from the
// build by tsconfig.build.json. App-local rather than in test-support
// because it runs the app's real guards; the helpers that need only the
// database (fixtures, lockWaiters) live there.
//
// The point of everything here is to let a spec ask whether a token WORKS —
// the real AuthGuard accepts it, the real gates do what they should with it,
// refresh accepts the refresh token — instead of decoding it and comparing
// claim literals. What a token asserts is pinned once, in the token-payload
// suite in sessions.service.spec.

export const TEST_JWT_SECRET = 'test-secret';

export const testJwt = () => new JwtService({ secret: TEST_JWT_SECRET });

// the route flags that matter to the two claim-reading gates
interface RouteFlags {
  skipEmailVerification?: boolean;
  skipMfaEnrollment?: boolean;
}

// A route that skips both gates — /auth/me is one. Presenting a token here
// asks only "is this a valid access token, and whose".
export const UNGATED: RouteFlags = {
  skipEmailVerification: true,
  skipMfaEnrollment: true,
};

type Admission =
  | { admitted: true; user: AuthenticatedUser }
  | { admitted: false; refusal: string };

// Presents a bearer token to the real guard chain, in the order AuthModule
// registers it: AuthGuard (signature, expiry, typ) → EmailVerifiedGuard →
// MfaEnrollmentGuard. With no flags the route is an ordinary one — verified
// and enrolled callers only — which is what nearly every route is.
export async function presentAccessToken(
  token: string,
  route: RouteFlags = {},
): Promise<Admission> {
  const handler = () => undefined;
  if (route.skipEmailVerification) {
    Reflect.defineMetadata(SKIP_EMAIL_VERIFICATION_KEY, true, handler);
  }
  if (route.skipMfaEnrollment) {
    Reflect.defineMetadata(SKIP_MFA_ENROLLMENT_KEY, true, handler);
  }

  const request: {
    headers: Record<string, string>;
    user?: AuthenticatedUser;
  } = { headers: { authorization: `Bearer ${token}` } };
  const context = {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  const reflector = new Reflector();
  try {
    await new AuthGuard(testJwt(), reflector).canActivate(context);
    new EmailVerifiedGuard(reflector).canActivate(context);
    new MfaEnrollmentGuard(reflector).canActivate(context);
  } catch (err) {
    if (err instanceof HttpException) {
      return { admitted: false, refusal: err.message };
    }
    throw err;
  }

  if (!request.user) throw new Error('AuthGuard admitted without a user');
  return { admitted: true, user: request.user };
}

// What @CurrentUser() would hand a handler for this token.
export async function callerOf(
  accessToken: string,
): Promise<AuthenticatedUser> {
  const admission = await presentAccessToken(accessToken, UNGATED);
  if (!admission.admitted) {
    throw new Error(`not a usable access token: ${admission.refusal}`);
  }
  return admission.user;
}

// "This pair is a working Session for this User": the access token gets
// through the real AuthGuard as them, and the refresh token is redeemable.
// Redeeming rotates it, so the successor pair is handed back for a spec that
// wants to carry on with the Session.
export async function expectWorkingSession(
  sessions: SessionsService,
  pair: TokenPair,
  userId: number,
): Promise<TokenPair> {
  expect(await presentAccessToken(pair.access_token, UNGATED)).toMatchObject({
    admitted: true,
    user: { sub: userId },
  });

  const next = await sessions.refreshTokens(pair.refresh_token);
  expect(await presentAccessToken(next.access_token, UNGATED)).toMatchObject({
    admitted: true,
    user: { sub: userId },
  });
  return next;
}

// Makes "two operations at the same moment" a fact rather than a hope. Two
// calls fired from one Promise.all usually interleave, but nothing promises
// it, and a concurrency spec that passes because the scheduler happened to
// run the calls back to back proves nothing.
//
// So the presented token's row is locked FOR UPDATE from a transaction of
// our own before the contenders start. Their reads go straight through (a
// plain SELECT takes no row lock), and each then parks on a lock: a
// redemption on the write that retires the held row, a revoke-all sweep
// either on that same row or behind a redemption that already holds the
// User row. Only once Postgres reports every contender waiting on a lock —
// i.e. every one of them is already past its "is this still live?" read —
// is the row released. What happens next is decided by the writes alone,
// which is exactly the part under test.
//
// To fix who is first in line, have `start` launch one contender, await
// lockWaiters(db, 1), then launch the next.
export async function raceForRefreshRow<T>(
  db: TestDb,
  refreshToken: string,
  contenders: number,
  start: () => Promise<T>,
): Promise<T> {
  const { jti } = testJwt().decode<{ jti: string }>(refreshToken);

  let racing: Promise<T> | undefined;
  await db.transaction(async (tx) => {
    await tx
      .select()
      .from(userRefreshTokensTable)
      .where(eq(userRefreshTokensTable.jti, jti))
      .for('update');

    racing = start();
    // a contender that fails while we're still polling is reported by the
    // `await racing` below, not as an unhandled rejection in the meantime
    racing.catch(() => undefined);

    await lockWaiters(tx, contenders);
  });
  if (!racing) throw new Error('raceForRefreshRow: contenders never started');
  return await racing;
}
