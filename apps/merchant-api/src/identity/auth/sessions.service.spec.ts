import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import {
  useTestDb,
  insertAccount,
  insertUser,
  insertUserMfa,
  insertUserPasskey,
} from 'test-support';
import {
  accountsTable,
  and,
  eq,
  isNotNull,
  isNull,
  sql,
  userPasskeysTable,
  userRefreshTokensTable,
  usersTable,
} from 'db/identity';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { FactorStateService } from './factor-state.service';
import { REFRESH_TOKEN_TTL_SECONDS, SessionsService } from './sessions.service';
import {
  TEST_JWT_SECRET,
  UNGATED,
  expectWorkingSession,
  presentAccessToken,
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

// Makes "two redemptions at the same moment" a fact rather than a hope. Two
// calls fired from one Promise.all usually interleave, but nothing promises
// it, and a concurrency spec that passes because the scheduler happened to
// run the calls back to back proves nothing.
//
// So the presented token's row is locked FOR UPDATE from a transaction of
// our own before the contenders start. Their reads go straight through (a
// plain SELECT takes no row lock), and each then parks on the write that
// retires the row. Only once Postgres reports every contender waiting on a
// lock — i.e. every one of them is already past its "is this still live?"
// read — is the lock released. What happens next is decided by the writes
// alone, which is exactly the part under test.
async function raceForRefreshRow<T>(
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

    const deadline = Date.now() + 4_000;
    for (;;) {
      // pg_locks, not pg_stat_activity: the stats views are snapshotted on
      // first read for the rest of the transaction, so from in here they
      // would go on reporting nobody waiting forever. pg_locks reads the
      // lock manager live. Nothing else shares this database (each jest
      // run boots its own container, maxWorkers: 1), so any ungranted lock
      // is a contender's.
      const { rows } = await tx.execute<{ waiting: number }>(
        sql`select count(*)::int as waiting from pg_locks where not granted`,
      );
      const waiting = rows[0]?.waiting ?? 0;
      if (waiting >= contenders) return;
      if (Date.now() > deadline) {
        throw new Error(
          `raceForRefreshRow: only ${waiting} of ${contenders} contenders ever blocked on the row — the race was not staged`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
  if (!racing) throw new Error('raceForRefreshRow: contenders never started');
  return await racing;
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

// Seeded straight into the tables rather than through AuthService.signup —
// nothing here is about how a User came to exist, only about their Sessions.
async function seedUser(
  opts: {
    emailVerifiedAt?: Date | null;
    factorRequiredAt?: Date;
    accountRequiresMfa?: boolean;
  } = {},
) {
  const account = await insertAccount(db, { name: 'Sessions Co' });
  if (opts.accountRequiresMfa) {
    await db
      .update(accountsTable)
      .set({ requireMfaAt: new Date() })
      .where(eq(accountsTable.id, account.id));
  }
  return insertUser(db, {
    accountId: account.id,
    emailVerifiedAt:
      opts.emailVerifiedAt === undefined ? new Date() : opts.emailVerifiedAt,
    ...(opts.factorRequiredAt
      ? { factorRequiredAt: opts.factorRequiredAt }
      : {}),
  });
}

async function deactivate(userId: number) {
  await db
    .update(usersTable)
    .set({ deactivatedAt: new Date() })
    .where(eq(usersTable.id, userId));
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
    await deactivate(user.id);

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
    const user = await seedUser({ emailVerifiedAt: null });

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
    const user = await seedUser({ emailVerifiedAt: null });

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
      const user = await seedUser({ emailVerifiedAt: null });
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

    await deactivate(userId);

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

    const [first, second] = await raceForRefreshRow(refresh_token, 2, () =>
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
        emailVerifiedAt: null,
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
    const user = await seedUser({ emailVerifiedAt: null });
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
      emailVerifiedAt: null,
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
    await deactivate(user.id);

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

  // Looks at rows, which this suite otherwise avoids: that the caller is
  // rotated *in place* rather than started afresh isn't visible from the
  // outside until a thief shows up, and it is the property reuse detection
  // depends on.
  it('rotates the caller in place, leaving the replacement in the same family', async () => {
    const user = await seedUser();
    const service = await build();
    const caller = await service.start(user.id);

    await service.revokeOthersAndRotate(user.id, caller.refresh_token);

    const rows = await db
      .select()
      .from(userRefreshTokensTable)
      .where(eq(userRefreshTokensTable.userId, user.id));
    expect(rows).toHaveLength(2);

    const live = rows.filter((r) => r.revokedAt === null);
    const retired = rows.filter((r) => r.revokedAt !== null);
    expect(live).toHaveLength(1);
    expect(retired).toHaveLength(1);
    // same family, and the retired row points at what replaced it — that
    // back-pointer is what reuse detection reads if the old token resurfaces
    expect(live[0]?.familyId).toBe(retired[0]?.familyId);
    expect(retired[0]?.replacedByJti).toBe(live[0]?.jti);
  });

  // changePassword shares the rotation with an ordinary refresh, and
  // merchant-web refreshes on every navigation, so the two can meet on the
  // same token. Whichever retires it first, the User must come out with one
  // live token, and it must be the one this call returned: a second live
  // successor in the caller's family is precisely the surviving copy that
  // changing the password exists to kill (OS-528).
  it('leaves exactly one live token, the one it returned, when it races a refresh of the same token (OS-528)', async () => {
    const user = await seedUser();
    const service = await build();
    const { refresh_token: callerToken } = await service.start(user.id);
    await service.start(user.id);

    const [result] = await raceForRefreshRow(callerToken, 2, () =>
      Promise.all([
        service.revokeOthersAndRotate(user.id, callerToken),
        // resolves either way: it wins the rotation, or replays the winner's
        service.refreshTokens(callerToken),
      ]),
    );

    const live = await db
      .select()
      .from(userRefreshTokensTable)
      .where(
        and(
          eq(userRefreshTokensTable.userId, user.id),
          isNull(userRefreshTokensTable.revokedAt),
        ),
      );
    expect(live.map((r) => r.jti)).toEqual([
      testJwt().decode<{ jti: string }>(result.refresh_token).jti,
    ]);

    await expectWorkingSession(service, result, user.id);
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
