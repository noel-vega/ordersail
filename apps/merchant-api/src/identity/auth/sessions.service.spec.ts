import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import {
  useTestDb,
  lockWaiters,
  liveRefreshTokenCount,
  deactivateUser,
  insertAccountWithUser,
  insertUserMfa,
  insertUserPasskey,
} from 'test-support';
import {
  accountsTable,
  and,
  eq,
  isNotNull,
  isNull,
  userPasskeysTable,
  userRefreshTokensTable,
  usersTable,
} from 'db/identity';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { FactorStateService } from './factor-state.service';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  SessionsService,
} from './sessions.service';
import {
  TEST_JWT_SECRET,
  UNGATED,
  expectWorkingSession,
  presentAccessToken,
  raceForRefreshRow,
  testJwt,
} from './sessions.spec-support';

// The SessionsService seam: given this database state and this call, do I
// get a token pair that WORKS — the real guards accept the access token,
// refresh accepts the refresh token — or the specific refusal. Every Session
// here begins the way a real one does, with start(userId); nothing builds a
// claim set or a family by hand.

const db = useTestDb();

// The grace window deliberately lets a just-rotated token be re-presented
// for 10s (a second tab, a retried request) and replay its replacement, so
// a freshly revoked row says nothing useful until that window has passed —
// "the other browser is refused now" passes for the wrong reason inside it.
// Backdating is how these specs get past it without sleeping; the live
// replacement (revokedAt still null) is left alone.
async function elapseGraceWindow(userId: number) {
  await db
    .update(userRefreshTokensTable)
    .set({ revokedAt: new Date(Date.now() - 60_000) })
    .where(
      and(
        eq(userRefreshTokensTable.userId, userId),
        isNotNull(userRefreshTokensTable.revokedAt),
      ),
    );
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Ages every Session the User holds so that it began `days` ago, and hands
// back the instant written so a spec can check it is carried forward
// untouched. Backdating the rows rather than faking the clock, for the same
// reason as elapseGraceWindow: jsonwebtoken reads the real clock too, and a
// faked one would expire the very tokens these specs present.
async function backdateSessionStart(userId: number, days: number) {
  const startedAt = new Date(Date.now() - days * DAY_MS);
  await db
    .update(userRefreshTokensTable)
    .set({ sessionStartedAt: startedAt })
    .where(eq(userRefreshTokensTable.userId, userId));
  return startedAt;
}

async function build() {
  const ref = await Test.createTestingModule({
    providers: [
      SessionsService,
      FactorStateService,
      { provide: DRIZZLE, useValue: db },
      {
        provide: JwtService,
        useValue: new JwtService({ secret: TEST_JWT_SECRET }),
      },
    ],
  }).compile();
  return ref.get(SessionsService);
}

// Nothing here is about how a User came to exist, only about their Sessions
// — and only the User is ever needed, not the Account around them.
async function seedUser(
  opts: Parameters<typeof insertAccountWithUser>[1] = {},
) {
  return (await insertAccountWithUser(db, opts)).user;
}

const REFUSED = 'Invalid or expired token';

describe('SessionsService.start', () => {
  it('starts a working Session for the User: a usable access token and a redeemable refresh token', async () => {
    const service = await build();
    const user = await seedUser();

    const session = await service.start(user.id);

    expect(await presentAccessToken(session.access_token)).toMatchObject({
      admitted: true,
      user: { sub: user.id, accountId: user.accountId },
    });
    await expectWorkingSession(service, session, user.id);
  });

  // Every sign-in path — password, challenge completion, passkey, signup,
  // accept-invite — ends by calling start and performs no check of its own,
  // so this one refusal covers all of them by construction.
  it('refuses a deactivated User, and leaves no Session behind', async () => {
    const service = await build();
    const user = await seedUser();
    await deactivateUser(db, user.id);

    await expect(service.start(user.id)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(await db.select().from(userRefreshTokensTable)).toHaveLength(0);
  });

  it('refuses a User that does not exist', async () => {
    const service = await build();

    await expect(service.start(999_999)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  // The claims come from the database, not from the caller — start takes
  // nothing but the id, so there is no way to ask for a more generous token.
  it('computes the gate claims from the database: an unverified User is held at the email gate', async () => {
    const service = await build();
    const user = await seedUser({ emailVerified: false });

    const { access_token } = await service.start(user.id);

    expect(await presentAccessToken(access_token)).toEqual({
      admitted: false,
      refusal: 'Email verification required',
    });
    // ...but still reaches the routes that exist to get them verified
    expect(await presentAccessToken(access_token, UNGATED)).toMatchObject({
      admitted: true,
    });
  });

  it('computes the gate claims from the database: a User who owes a Factor is held at the enrollment gate', async () => {
    const service = await build();
    const user = await seedUser({ accountRequiresMfa: true });

    const { access_token } = await service.start(user.id);

    expect(await presentAccessToken(access_token)).toEqual({
      admitted: false,
      refusal: 'MFA enrollment required',
    });
  });

  it('starts a separate Session each time — ending one leaves the other running', async () => {
    const service = await build();
    const user = await seedUser();
    const laptop = await service.start(user.id);
    const phone = await service.start(user.id);

    await service.logout(laptop.refresh_token);

    await expect(service.refreshTokens(laptop.refresh_token)).rejects.toThrow(
      REFUSED,
    );
    await expectWorkingSession(service, phone, user.id);
  });
});

// Pins the wire format itself. These key-set assertions are meant to fail
// loudly when a payload changes — adding a claim (or, as with hasMfaFactor in
// OS-505 and the identity fields in OS-527, removing one) should be a
// deliberate edit here, not something that slips through. This is the one
// place a token is decoded; every other spec asks whether it works.
describe('SessionsService token payloads', () => {
  const decode = (token: string) =>
    testJwt().decode<Record<string, unknown>>(token);

  it('signs an access token carrying only what is read without a database hit', async () => {
    const service = await build();
    const user = await seedUser({ emailVerified: false });

    const payload = decode((await service.start(user.id)).access_token);

    expect(Object.keys(payload).sort()).toEqual([
      'accountId',
      'emailVerified',
      'exp',
      'iat',
      'mfaEnrollmentSatisfied',
      'sub',
      'typ',
    ]);
    expect(payload).toMatchObject({
      sub: user.id,
      accountId: user.accountId,
      emailVerified: false,
      mfaEnrollmentSatisfied: true,
      typ: 'access',
    });
  });

  // A refresh token sits in a cookie for a week. It names the User and the
  // row, and nothing else — no email, no name, no claims.
  it('signs a refresh token carrying only sub, jti and typ — no personal data', async () => {
    const service = await build();
    const user = await seedUser();

    const payload = decode((await service.start(user.id)).refresh_token);

    expect(Object.keys(payload).sort()).toEqual([
      'exp',
      'iat',
      'jti',
      'sub',
      'typ',
    ]);
    expect(payload).toMatchObject({ sub: user.id, typ: 'refresh' });
  });

  // The number itself, not just the constant: this lifetime is the whole
  // window in which a revoked Session, a deactivated User or a stolen access
  // token keeps working on routes that don't read the database, so lengthening
  // it should mean editing a spec that says what it costs.
  it('gives the access token a 15-minute lifetime', async () => {
    const service = await build();
    const user = await seedUser();

    const payload = testJwt().decode<{ iat: number; exp: number }>(
      (await service.start(user.id)).access_token,
    );

    expect(payload.exp - payload.iat).toBe(15 * 60);
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(15 * 60);
  });

  // remintAccessToken() and refreshTokens() sign through the same private
  // signer as start(), but a second literal is exactly how two mints drift
  // apart — so each public mint is held to the one lifetime.
  it('gives a re-minted and a refreshed access token that same lifetime', async () => {
    const service = await build();
    const user = await seedUser();
    const s = await service.start(user.id);

    const lifetimeOf = (token: string) => {
      const { iat, exp } = testJwt().decode<{ iat: number; exp: number }>(
        token,
      );
      return exp - iat;
    };

    expect(lifetimeOf(await service.remintAccessToken(user.id))).toBe(
      ACCESS_TOKEN_TTL_SECONDS,
    );
    expect(
      lifetimeOf((await service.refreshTokens(s.refresh_token)).access_token),
    ).toBe(ACCESS_TOKEN_TTL_SECONDS);
  });

  it('gives the refresh token the lifetime the refresh cookie is written with', async () => {
    const service = await build();
    const user = await seedUser();

    const payload = testJwt().decode<{ iat: number; exp: number }>(
      (await service.start(user.id)).refresh_token,
    );

    expect(payload.exp - payload.iat).toBe(REFRESH_TOKEN_TTL_SECONDS);
  });

  // Tokens minted before OS-527 carried the whole claim set, identity fields
  // included, on both token types. They must keep working until they expire
  // — the extra fields are ignored, never trusted.
  describe('minted before the payloads were trimmed', () => {
    const legacyClaims = (user: { id: number; accountId: number }) => ({
      sub: user.id,
      email: 'stale@store.test',
      accountId: user.accountId,
      firstName: 'Stale',
      lastName: 'Name',
      emailVerified: true,
      mfaEnrollmentSatisfied: true,
    });

    it('still accepts an access token carrying the extra claims', async () => {
      const user = await seedUser();
      const legacy = await testJwt().signAsync(
        { ...legacyClaims(user), typ: 'access' },
        // the lifetime such a token was minted with, before OS-555 — a
        // shorter ACCESS_TOKEN_TTL_SECONDS doesn't cut short one already out
        { expiresIn: '8h' },
      );

      expect(await presentAccessToken(legacy)).toMatchObject({
        admitted: true,
        user: { sub: user.id, accountId: user.accountId },
      });
    });

    it('still redeems a refresh token carrying the extra claims — and trusts none of them', async () => {
      const service = await build();
      // unverified in the database, whatever the old token says
      const user = await seedUser({ emailVerified: false });
      const jti = randomUUID();
      await db
        .insert(userRefreshTokensTable)
        .values({ userId: user.id, jti, familyId: randomUUID() });
      const legacy = await testJwt().signAsync(
        { ...legacyClaims(user), typ: 'refresh', jti },
        { expiresIn: '7d' },
      );

      const next = await service.refreshTokens(legacy);

      expect(await presentAccessToken(next.access_token)).toEqual({
        admitted: false,
        refusal: 'Email verification required',
      });
      // and what it's exchanged for is a trimmed token
      expect(Object.keys(decode(next.refresh_token)).sort()).toEqual([
        'exp',
        'iat',
        'jti',
        'sub',
        'typ',
      ]);
    });
  });
});

describe('SessionsService.refreshTokens', () => {
  async function seedSession(opts: Parameters<typeof seedUser>[0] = {}) {
    const service = await build();
    const user = await seedUser(opts);
    const session = await service.start(user.id);
    return { service, user, userId: user.id, ...session };
  }

  it('continues the Session with a new working pair', async () => {
    const { service, userId, refresh_token } = await seedSession();

    const next = await service.refreshTokens(refresh_token);

    expect(next.refresh_token).not.toBe(refresh_token);
    await expectWorkingSession(service, next, userId);
  });

  it('rejects the refresh token of a deactivated user', async () => {
    const { service, userId, refresh_token } = await seedSession();

    await deactivateUser(db, userId);

    await expect(service.refreshTokens(refresh_token)).rejects.toThrow(REFUSED);
  });

  it('is single-use: the redeemed token is revoked and cannot be reused after the grace window', async () => {
    const { service, userId, refresh_token } = await seedSession();

    const { refresh_token: rotated } =
      await service.refreshTokens(refresh_token);
    expect(rotated).not.toBe(refresh_token);

    await elapseGraceWindow(userId);

    await expect(service.refreshTokens(refresh_token)).rejects.toThrow(REFUSED);
    // and reuse ends the whole Session — the token that *did* rotate
    // successfully is now dead too
    await expect(service.refreshTokens(rotated)).rejects.toThrow(REFUSED);
  });

  it('replays the same pair for a just-rotated-out token within the grace window (concurrent legitimate retry)', async () => {
    const { service, refresh_token } = await seedSession();

    const first = await service.refreshTokens(refresh_token);
    // presenting the now-superseded token again immediately (e.g. a second
    // concurrent tab) gets the same replacement pair back, not a rejection
    const second = await service.refreshTokens(refresh_token);

    // Compared by jti rather than by the raw strings: two mints in different
    // clock seconds produce different `iat`, so string equality was really
    // asserting "both calls landed in the same second" and flaked on a slow
    // runner. The invariant that matters is that the *same* replacement
    // token is handed back instead of rotating again.
    const jtiOf = (token: string) =>
      testJwt().decode<{ jti: string }>(token).jti;
    expect(jtiOf(second.refresh_token)).toBe(jtiOf(first.refresh_token));

    // and no extra row was minted by the replay
    const rows = await db.select().from(userRefreshTokensTable);
    expect(rows).toHaveLength(2);
  });

  // The grace window above only covers a second request that arrives after
  // the first has committed. Two that arrive together both read the row
  // while it is still live, and if the write that retires it isn't itself
  // conditional, both rotate: the family forks into two live successors and
  // the second write overwrites replacedByJti (OS-528).
  it('mints exactly one successor when the same live token is redeemed twice at once, and both callers get a usable pair (OS-528)', async () => {
    const { service, userId, refresh_token } = await seedSession();

    const [first, second] = await raceForRefreshRow(db, refresh_token, 2, () =>
      Promise.all([
        service.refreshTokens(refresh_token),
        service.refreshTokens(refresh_token),
      ]),
    );

    const rows = await db
      .select()
      .from(userRefreshTokensTable)
      .where(eq(userRefreshTokensTable.userId, userId));
    const live = rows.filter((r) => r.revokedAt === null);
    const retired = rows.filter((r) => r.revokedAt !== null);
    // the presented token and its one successor — not two successors
    expect(rows).toHaveLength(2);
    expect(live).toHaveLength(1);
    expect(retired).toHaveLength(1);
    expect(retired[0]?.replacedByJti).toBe(live[0]?.jti);
    expect(new Set(rows.map((r) => r.familyId)).size).toBe(1);

    // the loser was handed the winner's successor, not one of its own
    const jtiOf = (token: string) =>
      testJwt().decode<{ jti: string }>(token).jti;
    expect(jtiOf(first.refresh_token)).toBe(live[0]?.jti);
    expect(jtiOf(second.refresh_token)).toBe(live[0]?.jti);

    // "usable" means it works, not merely that it was returned: both access
    // tokens get through the real guards, and either refresh token can be
    // redeemed from here — a loser left holding a token that names no live
    // row would pass every assertion above and still be signed out at its
    // next refresh
    for (const pair of [first, second]) {
      expect(await presentAccessToken(pair.access_token)).toMatchObject({
        admitted: true,
        user: { sub: userId },
      });
    }
    const next = await service.refreshTokens(second.refresh_token);
    expect(jtiOf(next.refresh_token)).not.toBe(live[0]?.jti);
    // ...and the other tab, a moment later, replays that rotation as usual
    const replayed = await service.refreshTokens(first.refresh_token);
    expect(jtiOf(replayed.refresh_token)).toBe(jtiOf(next.refresh_token));
  });

  // Rotation alone never ends a Session: each refresh buys another 7 days,
  // so one used weekly would live forever. The absolute lifetime is measured
  // from when the Session started — the last time the User actually proved
  // who they are — and nothing a refresh does may move that instant (OS-556).
  describe('absolute Session lifetime (OS-556)', () => {
    const sessionRows = (userId: number) =>
      db
        .select()
        .from(userRefreshTokensTable)
        .where(eq(userRefreshTokensTable.userId, userId));

    it('refuses a Session that started 31 days ago, however live its refresh token, and ends it', async () => {
      const { service, userId, refresh_token } = await seedSession();
      await backdateSessionStart(userId, 31);

      await expect(service.refreshTokens(refresh_token)).rejects.toThrow(
        new UnauthorizedException(REFUSED),
      );

      // ended, not merely refused this once: nothing of it is left live
      const rows = await sessionRows(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.revokedAt).not.toBeNull();
      expect(rows[0]?.replacedByJti).toBeNull();
    });

    it('continues a Session that started 29 days ago, and the successor carries the same start', async () => {
      const { service, userId, refresh_token } = await seedSession();
      const startedAt = await backdateSessionStart(userId, 29);

      const next = await service.refreshTokens(refresh_token);

      const rows = await sessionRows(userId);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.sessionStartedAt)).toEqual([
        startedAt,
        startedAt,
      ]);
      // ...and again one rotation on: copied forward, never re-stamped
      await service.refreshTokens(next.refresh_token);
      expect(
        (await sessionRows(userId)).map((r) => r.sessionStartedAt),
      ).toEqual([startedAt, startedAt, startedAt]);
    });

    it('is not outrun by refreshing: a Session kept busy for 29 days still ends at 30', async () => {
      const { service, userId, refresh_token } = await seedSession();
      await backdateSessionStart(userId, 29);
      const next = await service.refreshTokens(refresh_token);

      // two more days pass on the successor minted a moment ago
      await backdateSessionStart(userId, 31);

      await expect(service.refreshTokens(next.refresh_token)).rejects.toThrow(
        REFUSED,
      );
    });

    it('neither extends nor resets the start when the grace window replays a rotation', async () => {
      const { service, userId, refresh_token } = await seedSession();
      const startedAt = await backdateSessionStart(userId, 29);

      await service.refreshTokens(refresh_token);
      await service.refreshTokens(refresh_token);

      // the replay minted nothing, and both rows still say when it began
      const rows = await sessionRows(userId);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.sessionStartedAt)).toEqual([
        startedAt,
        startedAt,
      ]);
    });

    // The grace window replays a live successor to whoever presents the
    // token it replaced. A Session past its lifetime has to be refused
    // before that, or the rotated-out token becomes a way back in.
    it('does not replay a rotated-out token of a Session past its lifetime, and ends it', async () => {
      const { service, userId, refresh_token } = await seedSession();
      const { refresh_token: successor } =
        await service.refreshTokens(refresh_token);
      await backdateSessionStart(userId, 31);

      // still inside the grace window — this would otherwise replay
      await expect(service.refreshTokens(refresh_token)).rejects.toThrow(
        REFUSED,
      );

      await expect(service.refreshTokens(successor)).rejects.toThrow(REFUSED);
      const rows = await sessionRows(userId);
      expect(rows.filter((r) => r.revokedAt === null)).toHaveLength(0);
    });

    it("leaves the User's younger Sessions running when an old one ends", async () => {
      const { service, userId, refresh_token } = await seedSession();
      await backdateSessionStart(userId, 31);
      const younger = await service.start(userId);

      await expect(service.refreshTokens(refresh_token)).rejects.toThrow(
        REFUSED,
      );

      await expectWorkingSession(service, younger, userId);
    });
  });

  // A refresh token must never work as an access token or vice versa — the
  // longer-lived one can't be used to call the API directly, and the one
  // that travels in a header can't be traded for a new Session.
  describe('token types are not interchangeable', () => {
    it('rejects an access token presented to the refresh flow', async () => {
      const { service, access_token } = await seedSession();

      await expect(service.refreshTokens(access_token)).rejects.toThrow(
        REFUSED,
      );
    });

    it('rejects a refresh token presented as a bearer access token', async () => {
      const { refresh_token } = await seedSession();

      expect(await presentAccessToken(refresh_token, UNGATED)).toMatchObject({
        admitted: false,
      });
    });
  });

  // Claims are baked in at mint time, so a rotation is where a change made
  // since then is noticed — by this browser and by every other one the User
  // is signed in on. The cases that matter are the ones a gate reads.
  describe('picks up what changed since the last mint', () => {
    it('an email verified elsewhere (OS-470)', async () => {
      const { service, userId, refresh_token } = await seedSession({
        emailVerified: false,
      });

      // a device that verified elsewhere and never got the re-minted access
      // token verify-email returns — a rotation is its next chance to notice
      await db
        .update(usersTable)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(usersTable.id, userId));

      const next = await service.refreshTokens(refresh_token);
      expect(await presentAccessToken(next.access_token)).toMatchObject({
        admitted: true,
      });
    });

    it('the account-wide MFA requirement turning on mid-Session (OS-473)', async () => {
      const { service, user, refresh_token } = await seedSession();

      await db
        .update(accountsTable)
        .set({ requireMfaAt: new Date() })
        .where(eq(accountsTable.id, user.accountId));

      const next = await service.refreshTokens(refresh_token);
      expect(await presentAccessToken(next.access_token)).toEqual({
        admitted: false,
        refusal: 'MFA enrollment required',
      });
    });

    // The whole reason users.factorRequiredAt exists (OS-494): merchant-web
    // refreshes on every navigation, and an unsatisfied claim that wasn't
    // backed by stored state flipped to true here, one click after joining.
    it('nothing, for a joined staff User who still owes a Factor — the gate stays shut', async () => {
      const { service, refresh_token } = await seedSession({
        factorRequiredAt: new Date(),
      });

      const next = await service.refreshTokens(refresh_token);
      expect(await presentAccessToken(next.access_token)).toEqual({
        admitted: false,
        refusal: 'MFA enrollment required',
      });
    });

    it.each([
      [
        'an authenticator app',
        (userId: number) =>
          insertUserMfa(db, { userId, confirmedAt: new Date() }),
      ],
      ['a passkey', (userId: number) => insertUserPasskey(db, { userId })],
    ])('a required Factor being enrolled as %s', async (_label, enroll) => {
      const { service, userId, access_token, refresh_token } =
        await seedSession({ accountRequiresMfa: true });
      expect(await presentAccessToken(access_token)).toMatchObject({
        admitted: false,
      });

      await enroll(userId);

      const next = await service.refreshTokens(refresh_token);
      expect(await presentAccessToken(next.access_token)).toMatchObject({
        admitted: true,
      });
    });

    it('the last passkey being removed while a Factor is required', async () => {
      const service = await build();
      const user = await seedUser({ accountRequiresMfa: true });
      const passkey = await insertUserPasskey(db, { userId: user.id });
      const session = await service.start(user.id);
      // the claim first has to be true, or "drops" proves nothing
      expect(await presentAccessToken(session.access_token)).toMatchObject({
        admitted: true,
      });

      await db
        .delete(userPasskeysTable)
        .where(eq(userPasskeysTable.id, passkey.id));

      const next = await service.refreshTokens(session.refresh_token);
      expect(await presentAccessToken(next.access_token)).toEqual({
        admitted: false,
        refusal: 'MFA enrollment required',
      });
    });
  });
});

describe('SessionsService.remintAccessToken', () => {
  it('reflects an email verified mid-Session, without waiting for a refresh', async () => {
    const service = await build();
    const user = await seedUser({ emailVerified: false });
    const session = await service.start(user.id);
    await db
      .update(usersTable)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(usersTable.id, user.id));

    const reminted = await service.remintAccessToken(user.id);

    // the token they held is still stuck at the gate; the new one isn't
    expect(await presentAccessToken(session.access_token)).toMatchObject({
      admitted: false,
    });
    expect(await presentAccessToken(reminted)).toMatchObject({
      admitted: true,
      user: { sub: user.id },
    });
  });

  it('reflects a first required Factor enrolled mid-Session', async () => {
    const service = await build();
    const user = await seedUser({ factorRequiredAt: new Date() });
    await service.start(user.id);
    await insertUserPasskey(db, { userId: user.id });

    const reminted = await service.remintAccessToken(user.id);

    expect(await presentAccessToken(reminted)).toMatchObject({
      admitted: true,
    });
  });

  // Computed from the database like every other mint — so it can only ever
  // say what is true, including the claim the caller wasn't here about.
  it('never grants a claim the database does not back', async () => {
    const service = await build();
    const user = await seedUser({
      emailVerified: false,
      factorRequiredAt: new Date(),
    });
    await insertUserPasskey(db, { userId: user.id });

    const reminted = await service.remintAccessToken(user.id);

    expect(await presentAccessToken(reminted)).toEqual({
      admitted: false,
      refusal: 'Email verification required',
    });
  });

  it('leaves the refresh token alone — same Session, still redeemable', async () => {
    const service = await build();
    const user = await seedUser();
    const session = await service.start(user.id);

    await service.remintAccessToken(user.id);

    expect(await db.select().from(userRefreshTokensTable)).toHaveLength(1);
    await expectWorkingSession(service, session, user.id);
  });

  it('refuses a deactivated User', async () => {
    const service = await build();
    const user = await seedUser();
    await service.start(user.id);
    await deactivateUser(db, user.id);

    await expect(service.remintAccessToken(user.id)).rejects.toThrow(REFUSED);
  });
});

describe('SessionsService.logout', () => {
  it('ends the Session for good — the refresh token can no longer be redeemed', async () => {
    const service = await build();
    const user = await seedUser();
    const { refresh_token } = await service.start(user.id);

    await service.logout(refresh_token);

    await expect(service.refreshTokens(refresh_token)).rejects.toThrow(REFUSED);
  });

  it('ends the Session even when handed a token that has since been rotated out', async () => {
    const service = await build();
    const user = await seedUser();
    const { refresh_token: stale } = await service.start(user.id);
    const { refresh_token: current } = await service.refreshTokens(stale);

    await service.logout(stale);

    await expect(service.refreshTokens(current)).rejects.toThrow(REFUSED);
  });

  // Total: signing out is never an error screen.
  it.each([
    ['garbage', () => Promise.resolve('not-a-real-token')],
    [
      'an access token',
      async () => {
        const user = await seedUser();
        return (await (await build()).start(user.id)).access_token;
      },
    ],
    [
      'a well-formed refresh token naming no Session',
      () =>
        testJwt().signAsync(
          { sub: 1, jti: randomUUID(), typ: 'refresh' },
          { expiresIn: '7d' },
        ),
    ],
  ])('is a quiet success for %s', async (_label, token) => {
    const service = await build();
    await expect(service.logout(await token())).resolves.toBeUndefined();
  });
});

describe('SessionsService.revokeAll', () => {
  it('ends every Session the User holds', async () => {
    const service = await build();
    const user = await seedUser();
    const laptop = await service.start(user.id);
    const phone = await service.start(user.id);

    await service.revokeAll(user.id);

    await expect(service.refreshTokens(laptop.refresh_token)).rejects.toThrow(
      REFUSED,
    );
    await expect(service.refreshTokens(phone.refresh_token)).rejects.toThrow(
      REFUSED,
    );
  });

  it("leaves another User's Sessions alone", async () => {
    const service = await build();
    const user = await seedUser();
    const bystander = await seedUser();
    await service.start(user.id);
    const theirs = await service.start(bystander.id);

    await service.revokeAll(user.id);

    await expectWorkingSession(service, theirs, bystander.id);
  });

  // merchant-web refreshes on every navigation, so a sweep can start while a
  // rotation has retired the old row and inserted its successor but not yet
  // committed. A sweep that only waits on the old row never sees that
  // successor — it isn't in the sweep's snapshot — and the Session "revoke
  // all" was called to end carries on under a new token. The refresh is
  // parked first here, so it is the one in flight when the sweep arrives.
  it('ends a Session whose refresh is already in flight — the successor does not slip past the sweep', async () => {
    const service = await build();
    const user = await seedUser();
    const { refresh_token } = await service.start(user.id);

    const [refreshed] = await raceForRefreshRow(
      db,
      refresh_token,
      2,
      async () => {
        const refreshing = service.refreshTokens(refresh_token);
        refreshing.catch(() => undefined);
        await lockWaiters(db, 1);
        return Promise.all([refreshing, service.revokeAll(user.id)]);
      },
    );

    // the refresh got there first and was answered — with a token the sweep
    // then ended along with everything else
    await expect(
      service.refreshTokens(refreshed.refresh_token),
    ).rejects.toThrow(REFUSED);
    expect(await liveRefreshTokenCount(db, user.id)).toBe(0);
  });

  // The other order: the sweep holds the User first, and the refresh — which
  // read its row as live before the sweep got to it — must find nothing left
  // to rotate once it is let through.
  it('refuses a refresh that was let through only after the sweep, and writes nothing', async () => {
    const service = await build();
    const user = await seedUser();
    const { refresh_token } = await service.start(user.id);

    const [, refreshing] = await raceForRefreshRow(
      db,
      refresh_token,
      2,
      async () => {
        const sweeping = service.revokeAll(user.id);
        sweeping.catch(() => undefined);
        await lockWaiters(db, 1);
        return Promise.all([
          sweeping,
          service.refreshTokens(refresh_token).then(
            () => 'continued' as const,
            (err: unknown) => err,
          ),
        ]);
      },
    );

    expect(refreshing).toBeInstanceOf(UnauthorizedException);
    expect(await liveRefreshTokenCount(db, user.id)).toBe(0);
    expect(await db.select().from(userRefreshTokensTable)).toHaveLength(1);
  });
});

describe('SessionsService.revokeOthersAndRotate (OS-385)', () => {
  it('kills the token the caller presented along with every other session', async () => {
    const user = await seedUser();
    const service = await build();
    const caller = await service.start(user.id);
    const otherBrowser = await service.start(user.id);

    await service.revokeOthersAndRotate(user.id, caller.refresh_token);
    await elapseGraceWindow(user.id);

    // the second browser is refused at its next rotation...
    await expect(
      service.refreshTokens(otherBrowser.refresh_token),
    ).rejects.toThrow(REFUSED);
    // ...and so is the caller's own old token, which is the point: a stolen
    // copy of it lives in the caller's family and would otherwise survive
    await expect(service.refreshTokens(caller.refresh_token)).rejects.toThrow(
      REFUSED,
    );
  });

  it('hands the caller a replacement that keeps them signed in', async () => {
    const user = await seedUser();
    const service = await build();
    const caller = await service.start(user.id);

    const replacement = await service.revokeOthersAndRotate(
      user.id,
      caller.refresh_token,
    );

    await expectWorkingSession(service, replacement, user.id);
  });

  // The grace window exists for two tabs redeeming the same token at once.
  // This rotation is not that: it happens because a credential changed, and
  // the token it retires is the one a thief may hold a copy of. Replaying
  // the replacement to whoever presents the old token next — as an ordinary
  // rotation would for 10 seconds — hands the thief the new Session.
  it("never replays the replacement to the caller's old token, even inside the grace window — presenting it ends the Session", async () => {
    const user = await seedUser();
    const service = await build();
    const caller = await service.start(user.id);

    const replacement = await service.revokeOthersAndRotate(
      user.id,
      caller.refresh_token,
    );

    // no elapseGraceWindow: this is the very next moment
    await expect(service.refreshTokens(caller.refresh_token)).rejects.toThrow(
      REFUSED,
    );
    // ...and it was handled as reuse. The caller was rotated in place, so the
    // replacement belongs to the Session the old token just took down — both
    // parties sign in again, and only one of them knows the new password.
    await expect(
      service.refreshTokens(replacement.refresh_token),
    ).rejects.toThrow(REFUSED);
    expect(await liveRefreshTokenCount(db, user.id)).toBe(0);
  });

  // changePassword shares the rotation with an ordinary refresh, and
  // merchant-web refreshes on every navigation, so the two can meet on the
  // same token. Whichever retires it first, the User must come out with one
  // live token, and it must be the one this call returned: a second live
  // successor in the caller's family is precisely the surviving copy that
  // changing the password exists to kill (OS-528). Both orders are staged —
  // whoever parks on the row first is first in line when it is released.
  describe('racing a refresh of the same token (OS-528)', () => {
    const expectOnlySessionLeftIs = async (
      service: SessionsService,
      userId: number,
      pair: { access_token: string; refresh_token: string },
    ) => {
      expect(await liveRefreshTokenCount(db, userId)).toBe(1);
      // redeemable, so the one live token is this one
      await expectWorkingSession(service, pair, userId);
    };

    it('leaves exactly one live token, the one it returned, when the refresh gets there first', async () => {
      const user = await seedUser();
      const service = await build();
      const { refresh_token: callerToken } = await service.start(user.id);
      await service.start(user.id);

      const [, result] = await raceForRefreshRow(
        db,
        callerToken,
        2,
        async () => {
          // resolves: it wins the rotation
          const refreshing = service.refreshTokens(callerToken);
          refreshing.catch(() => undefined);
          await lockWaiters(db, 1);
          return Promise.all([
            refreshing,
            service.revokeOthersAndRotate(user.id, callerToken),
          ]);
        },
      );

      await expectOnlySessionLeftIs(service, user.id, result);
    });

    // The refresh that loses here is not replayed the winner's successor —
    // it may be the thief's — but neither is it reuse: the token was live
    // when it was read, and lost to a rotation that leaves nothing to
    // replay. It is refused, and the caller's replacement carries on.
    it('leaves exactly one live token, the one it returned, when it gets there first — the refresh is refused', async () => {
      const user = await seedUser();
      const service = await build();
      const { refresh_token: callerToken } = await service.start(user.id);
      await service.start(user.id);

      const [result, refreshing] = await raceForRefreshRow(
        db,
        callerToken,
        2,
        async () => {
          const rotating = service.revokeOthersAndRotate(user.id, callerToken);
          rotating.catch(() => undefined);
          await lockWaiters(db, 1);
          return Promise.all([
            rotating,
            service.refreshTokens(callerToken).then(
              () => 'continued' as const,
              (err: unknown) => err,
            ),
          ]);
        },
      );

      expect(refreshing).toBeInstanceOf(UnauthorizedException);
      await expectOnlySessionLeftIs(service, user.id, result);
    });
  });

  // The same meeting, but on somebody else's token: another browser — the
  // one the password is being changed to get rid of — is mid-refresh when
  // the sweep of "every other Session" starts. Its successor is inserted but
  // not yet committed, so a sweep that waits only on the old row never sees
  // it, and the attacker's in-flight refresh outlives the password change.
  it('ends another Session whose refresh is already in flight when the sweep starts', async () => {
    const user = await seedUser();
    const service = await build();
    const caller = await service.start(user.id);
    const otherBrowser = await service.start(user.id);

    const [refreshed, result] = await raceForRefreshRow(
      db,
      otherBrowser.refresh_token,
      2,
      async () => {
        const refreshing = service.refreshTokens(otherBrowser.refresh_token);
        refreshing.catch(() => undefined);
        await lockWaiters(db, 1);
        return Promise.all([
          refreshing,
          service.revokeOthersAndRotate(user.id, caller.refresh_token),
        ]);
      },
    );

    await expect(
      service.refreshTokens(refreshed.refresh_token),
    ).rejects.toThrow(REFUSED);
    // one Session left, and it is the caller's
    expect(await liveRefreshTokenCount(db, user.id)).toBe(1);
    await expectWorkingSession(service, result, user.id);
  });

  // A changed password rotates the caller's Session, it doesn't begin a new
  // one — so the rotation carries the original start forward like any other.
  // Only the branches that really do start a Session afresh get a new start
  // (OS-556).
  describe('and the absolute Session lifetime (OS-556)', () => {
    const liveRow = async (userId: number) => {
      const live = await db
        .select()
        .from(userRefreshTokensTable)
        .where(
          and(
            eq(userRefreshTokensTable.userId, userId),
            isNull(userRefreshTokensTable.revokedAt),
          ),
        );
      const [row, ...others] = live;
      if (!row || others.length > 0) {
        throw new Error(`expected one live token, found ${live.length}`);
      }
      return row;
    };
    const expectStartedJustNow = (startedAt: Date) => {
      expect(Date.now() - startedAt.getTime()).toBeLessThan(60_000);
    };

    it('keeps the original start when it rotates the caller in place', async () => {
      const user = await seedUser();
      const service = await build();
      const caller = await service.start(user.id);
      const startedAt = await backdateSessionStart(user.id, 29);

      await service.revokeOthersAndRotate(user.id, caller.refresh_token);

      expect((await liveRow(user.id)).sessionStartedAt).toEqual(startedAt);
    });

    it('begins a new one when it has to start fresh (no refresh cookie)', async () => {
      const user = await seedUser();
      const service = await build();
      await service.start(user.id);
      await backdateSessionStart(user.id, 29);

      await service.revokeOthersAndRotate(user.id, undefined);

      expectStartedJustNow((await liveRow(user.id)).sessionStartedAt);
    });

    // The refresh is parked on the row first, so it is first in line when
    // the lock goes and the password change is the one that loses.
    it('begins a new one when it loses the rotation to a concurrent refresh', async () => {
      const user = await seedUser();
      const service = await build();
      const { refresh_token: callerToken } = await service.start(user.id);
      await backdateSessionStart(user.id, 29);
      const [original] = await db.select().from(userRefreshTokensTable);

      const [, result] = await raceForRefreshRow(
        db,
        callerToken,
        2,
        async () => {
          const refreshing = service.refreshTokens(callerToken);
          refreshing.catch(() => undefined);
          await lockWaiters(db, 1);
          return Promise.all([
            refreshing,
            service.revokeOthersAndRotate(user.id, callerToken),
          ]);
        },
      );

      const live = await liveRow(user.id);
      expect(live.jti).toBe(
        testJwt().decode<{ jti: string }>(result.refresh_token).jti,
      );
      // it really was the losing branch: the caller left the family behind
      expect(live.familyId).not.toBe(original?.familyId);
      expectStartedJustNow(live.sessionStartedAt);
    });

    // Rotating a Session already past its lifetime would hand back a refresh
    // token that is refused the first time it's used — signing the caller out
    // minutes after they changed their password. They have just proved they
    // know it, which is all a new Session ever asks.
    it('begins a new one rather than rotating a Session already past its lifetime', async () => {
      const user = await seedUser();
      const service = await build();
      const caller = await service.start(user.id);
      await backdateSessionStart(user.id, 31);

      const replacement = await service.revokeOthersAndRotate(
        user.id,
        caller.refresh_token,
      );

      expectStartedJustNow((await liveRow(user.id)).sessionStartedAt);
      await expectWorkingSession(service, replacement, user.id);
      await expect(service.refreshTokens(caller.refresh_token)).rejects.toThrow(
        REFUSED,
      );
    });
  });

  it('revokes every session and starts a fresh one when there is no refresh cookie', async () => {
    const user = await seedUser();
    const service = await build();
    const someBrowser = await service.start(user.id);

    const fresh = await service.revokeOthersAndRotate(user.id, undefined);

    await expect(
      service.refreshTokens(someBrowser.refresh_token),
    ).rejects.toThrow(REFUSED);
    await expectWorkingSession(service, fresh, user.id);
  });

  it("leaves another user's sessions alone", async () => {
    const user = await seedUser();
    const bystander = await seedUser();
    const service = await build();
    const theirs = await service.start(bystander.id);

    await service.revokeOthersAndRotate(user.id, undefined);

    await expectWorkingSession(service, theirs, bystander.id);
  });

  it('does not re-stamp a family that was already revoked', async () => {
    const user = await seedUser();
    const revokedAt = new Date('2020-01-01T00:00:00.000Z');
    await db.insert(userRefreshTokensTable).values({
      userId: user.id,
      jti: 'already-revoked-jti',
      familyId: 'already-revoked-family',
      revokedAt,
    });
    const service = await build();

    await service.revokeOthersAndRotate(user.id, undefined);

    const [row] = await db
      .select()
      .from(userRefreshTokensTable)
      .where(eq(userRefreshTokensTable.jti, 'already-revoked-jti'));
    expect(row?.revokedAt).toEqual(revokedAt);
  });
});

describe('SessionsService.revokeOtherSessions (OS-502)', () => {
  it('leaves the calling session running — unrotated, and still redeemable', async () => {
    const user = await seedUser();
    const service = await build();
    const caller = await service.start(user.id);

    await service.revokeOtherSessions(user.id, caller.refresh_token);

    // Nothing was written back to this family, so the token the browser
    // already holds is still the live one — the whole point of not rotating
    // here is that there's no replacement cookie to deliver. Asserted on the
    // row rather than only on "it still refreshes", because a revoked row
    // with a successor would refresh too (that's the grace window), and
    // that's precisely what this endpoint must NOT have produced.
    const rows = await db
      .select()
      .from(userRefreshTokensTable)
      .where(eq(userRefreshTokensTable.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).toBeNull();
    expect(rows[0]?.replacedByJti).toBeNull();

    await expectWorkingSession(service, caller, user.id);
  });

  it('refuses every other browser at its next refresh', async () => {
    const user = await seedUser();
    const service = await build();
    const caller = await service.start(user.id);
    const laptop = await service.start(user.id);
    const phone = await service.start(user.id);

    await service.revokeOtherSessions(user.id, caller.refresh_token);
    // Without this the assertions below would pass for the wrong reason: a
    // token revoked moments ago is still inside the 10s replay window, where
    // refreshTokens deliberately hands back the replacement instead of
    // refusing. There is no replacement here, so it refuses either way — but
    // only after the window is a refusal evidence of revocation.
    await elapseGraceWindow(user.id);

    await expect(service.refreshTokens(laptop.refresh_token)).rejects.toThrow(
      REFUSED,
    );
    await expect(service.refreshTokens(phone.refresh_token)).rejects.toThrow(
      REFUSED,
    );
  });

  // With no usable cookie there is no family to call "this one". The two
  // obvious answers are both wrong: revoking everything signs out the person
  // who asked to stay (OS-503 story 20), and starting them a fresh family
  // would hand a 7-day refresh token to anyone holding a bare access token,
  // from an endpoint that skips the password only because it never grants
  // anything. So it refuses, and — asserted below — touches nothing.
  it('refuses when no cookie reaches us, and revokes nothing', async () => {
    const user = await seedUser();
    const service = await build();
    const someBrowser = await service.start(user.id);

    await expect(
      service.revokeOtherSessions(user.id, undefined),
    ).rejects.toThrow(ConflictException);

    const rows = await db
      .select()
      .from(userRefreshTokensTable)
      .where(eq(userRefreshTokensTable.userId, user.id));
    // no family was started for the caller, and the one that existed is
    // untouched — still redeemable, not merely present
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).toBeNull();
    await expectWorkingSession(service, someBrowser, user.id);
  });

  it('refuses on a stale cookie too, rather than sparing the family it names', async () => {
    const user = await seedUser();
    const service = await build();
    const { refresh_token: staleToken } = await service.start(user.id);
    // this browser refreshed at some point, so the cookie it holds now is
    // the successor; `staleToken` is the rotated-out predecessor
    const current = await service.refreshTokens(staleToken);
    const otherBrowser = await service.start(user.id);

    // A stale cookie is exactly what a browser someone else is holding might
    // present, so it must not be allowed to nominate a family to spare while
    // everything else dies. Liveness, not just ownership, decides whether
    // there's a "this one" — and without one the call does nothing at all.
    await expect(
      service.revokeOtherSessions(user.id, staleToken),
    ).rejects.toThrow(ConflictException);

    await elapseGraceWindow(user.id);
    await expectWorkingSession(service, current, user.id);
    await expectWorkingSession(service, otherBrowser, user.id);
  });

  it("refuses a cookie that names another User's Session, and revokes nothing", async () => {
    const user = await seedUser();
    const bystander = await seedUser();
    const service = await build();
    const mine = await service.start(user.id);
    const theirs = await service.start(bystander.id);

    await expect(
      service.revokeOtherSessions(user.id, theirs.refresh_token),
    ).rejects.toThrow(ConflictException);

    await expectWorkingSession(service, mine, user.id);
    await expectWorkingSession(service, theirs, bystander.id);
  });

  it("leaves another user's sessions alone", async () => {
    const user = await seedUser();
    const bystander = await seedUser();
    const service = await build();
    const caller = await service.start(user.id);
    const theirs = await service.start(bystander.id);

    await service.revokeOtherSessions(user.id, caller.refresh_token);

    await expectWorkingSession(service, theirs, bystander.id);
  });

  it('does not re-stamp a family that was already revoked', async () => {
    const user = await seedUser();
    const revokedAt = new Date('2020-01-01T00:00:00.000Z');
    await db.insert(userRefreshTokensTable).values({
      userId: user.id,
      jti: 'already-revoked-jti',
      familyId: 'already-revoked-family',
      revokedAt,
    });
    const service = await build();
    const caller = await service.start(user.id);

    await service.revokeOtherSessions(user.id, caller.refresh_token);

    const [row] = await db
      .select()
      .from(userRefreshTokensTable)
      .where(eq(userRefreshTokensTable.jti, 'already-revoked-jti'));
    expect(row?.revokedAt).toEqual(revokedAt);
  });
});
