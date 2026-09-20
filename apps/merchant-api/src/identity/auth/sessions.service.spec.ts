import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConflictException } from '@nestjs/common';
import { useTestDb, insertAccount, insertUser } from 'test-support';
import {
  and,
  eq,
  isNotNull,
  isNull,
  sql,
  userRefreshTokensTable,
  usersTable,
} from 'db/identity';
import { type AuthenticatedUser } from 'src/shared/auth/decorators';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { FactorStateService } from './factor-state.service';
import { SessionsService } from './sessions.service';

const db = useTestDb();

// The grace window deliberately lets a just-rotated token be re-presented
// for 10s (a second tab, a retried request) and replay its replacement, so
// a freshly revoked row says nothing useful until that window has passed —
// "the other browser is refused now" passes for the wrong reason inside it.
// Backdating is how the refreshTokens specs get past it without sleeping;
// the live replacement (revokedAt still null) is left alone.
//
// Module-scope so both revocation suites (revokeOthersAndRotate, OS-385;
// revokeOtherSessions, OS-502) use the one definition — they'd otherwise
// each carry their own notion of "far enough past the window".
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
  const { jti } = new JwtService({ secret: 'test-secret' }).decode<{
    jti: string;
  }>(refreshToken);

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
        useValue: new JwtService({ secret: 'test-secret' }),
      },
    ],
  }).compile();
  return ref.get(SessionsService);
}

// Seeded straight into the tables rather than through AuthService.signup —
// nothing here is about how a User came to exist, only about their Sessions.
async function seedUser(opts: { emailVerifiedAt?: Date | null } = {}) {
  const account = await insertAccount(db, { name: 'Sessions Co' });
  return insertUser(db, {
    accountId: account.id,
    emailVerifiedAt:
      opts.emailVerifiedAt === undefined ? new Date() : opts.emailVerifiedAt,
  });
}

function claimsFor(user: {
  id: number;
  email: string;
  accountId: number;
  emailVerifiedAt: Date | null;
}) {
  return {
    sub: user.id,
    email: user.email,
    accountId: user.accountId,
    firstName: 'Staff',
    lastName: 'Member',
    emailVerified: user.emailVerifiedAt !== null,
    mfaEnrollmentSatisfied: true,
  };
}

// Pins the wire format itself, not just the mappers that feed it. These
// key-set assertions are meant to fail loudly when the claim set changes —
// adding a claim (or, as with hasMfaFactor in OS-505, removing a dead one)
// should be a deliberate edit here, not something that slips through.
describe('SessionsService token payloads (OS-482)', () => {
  const decode = (token: string) =>
    new JwtService({ secret: 'test-secret' }).decode<Record<string, unknown>>(
      token,
    );

  const claims = {
    sub: 0, // replaced per-test with a real user id where an FK needs one
    email: 'dana@cactus.test',
    accountId: 0,
    firstName: 'Dana',
    lastName: 'Scully',
    emailVerified: false,
    mfaEnrollmentSatisfied: true,
  };

  it('signs an access token with exactly the claim set plus typ', async () => {
    const service = await build();
    const payload = decode(await service.createAccessToken(claims));

    expect(Object.keys(payload).sort()).toEqual([
      'accountId',
      'email',
      'emailVerified',
      'exp',
      'firstName',
      'iat',
      'lastName',
      'mfaEnrollmentSatisfied',
      'sub',
      'typ',
    ]);
    expect(payload).toMatchObject({ ...claims, typ: 'access' });
  });

  it('signs a refresh token with the same claims plus typ and jti', async () => {
    const service = await build();
    const user = await seedUser();
    const payload = decode(
      await service.createRefreshToken(
        { ...claims, sub: user.id, accountId: user.accountId },
        randomUUID(),
      ),
    );

    expect(Object.keys(payload).sort()).toEqual([
      'accountId',
      'email',
      'emailVerified',
      'exp',
      'firstName',
      'iat',
      'jti',
      'lastName',
      'mfaEnrollmentSatisfied',
      'sub',
      'typ',
    ]);
    expect(payload).toMatchObject({ typ: 'refresh', sub: user.id });
  });
});

describe('SessionsService.refreshTokens (OS-467)', () => {
  async function seedSession() {
    const service = await build();
    // unverified, as a User fresh out of signup is — the OS-470 case below
    // needs the presented token to carry emailVerified: false
    const user = await seedUser({ emailVerifiedAt: null });
    const refreshToken = await service.createRefreshToken(
      claimsFor(user),
      randomUUID(),
    );
    return { service, user, userId: user.id, refreshToken };
  }

  it('mints a new access + refresh pair for an active user', async () => {
    const { service, refreshToken } = await seedSession();

    const result = await service.refreshTokens(refreshToken);
    expect(typeof result.access_token).toBe('string');
    expect(typeof result.refresh_token).toBe('string');
  });

  it('picks up a verification that happened since the refresh token was minted, not the stale claim (OS-470)', async () => {
    const { service, userId, refreshToken } = await seedSession();

    // the presented refresh token still carries emailVerified: false — this
    // simulates a device that verified elsewhere and never got the
    // re-minted access token verify-email returns, so a rotation is the next chance to notice
    await db
      .update(usersTable)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(usersTable.id, userId));

    const jwt = new JwtService({ secret: 'test-secret' });
    const result = await service.refreshTokens(refreshToken);
    expect(
      jwt.decode<{ emailVerified: boolean }>(result.access_token)
        ?.emailVerified,
    ).toBe(true);
    expect(
      jwt.decode<{ emailVerified: boolean }>(result.refresh_token)
        ?.emailVerified,
    ).toBe(true);
  });

  it('rejects the refresh token of a deactivated user', async () => {
    const { service, userId, refreshToken } = await seedSession();

    await db
      .update(usersTable)
      .set({ deactivatedAt: new Date() })
      .where(eq(usersTable.id, userId));

    await expect(service.refreshTokens(refreshToken)).rejects.toThrow(
      'Invalid or expired token',
    );
  });

  it('is single-use: the redeemed token is revoked and cannot be reused after the grace window', async () => {
    const { service, refreshToken } = await seedSession();

    const { refresh_token: rotated } =
      await service.refreshTokens(refreshToken);
    expect(rotated).not.toBe(refreshToken);

    // simulate the grace window having elapsed by backdating revokedAt,
    // rather than sleeping in the test — no WHERE needed, this test's
    // seedSession() is the only row in the (per-test, truncated) table
    await db
      .update(userRefreshTokensTable)
      .set({ revokedAt: new Date(Date.now() - 60_000) });

    await expect(service.refreshTokens(refreshToken)).rejects.toThrow(
      'Invalid or expired token',
    );
    // and reuse revokes the whole family — the token that *did* rotate
    // successfully is now dead too
    await expect(service.refreshTokens(rotated)).rejects.toThrow(
      'Invalid or expired token',
    );
  });

  it('replays the same pair for a just-rotated-out token within the grace window (concurrent legitimate retry)', async () => {
    const { service, refreshToken } = await seedSession();

    const first = await service.refreshTokens(refreshToken);
    // presenting the now-superseded token again immediately (e.g. a second
    // concurrent tab) gets the same replacement pair back, not a rejection
    const second = await service.refreshTokens(refreshToken);

    // Compared by jti and claims rather than by the raw strings: two mints
    // in different clock seconds produce different `iat`, so string equality
    // was really asserting "both calls landed in the same second" and flaked
    // on a slow runner. The invariant that matters is that the *same*
    // replacement token is handed back instead of rotating again.
    const jwt = new JwtService({ secret: 'test-secret' });
    const firstRefresh = jwt.decode<{ jti: string; sub: number }>(
      first.refresh_token,
    );
    const secondRefresh = jwt.decode<{ jti: string; sub: number }>(
      second.refresh_token,
    );
    expect(secondRefresh.jti).toBe(firstRefresh.jti);
    expect(secondRefresh.sub).toBe(firstRefresh.sub);

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
    const { service, userId, refreshToken } = await seedSession();

    const [first, second] = await raceForRefreshRow(refreshToken, 2, () =>
      Promise.all([
        service.refreshTokens(refreshToken),
        service.refreshTokens(refreshToken),
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
    const jwt = new JwtService({ secret: 'test-secret' });
    const jtiOf = (token: string) => jwt.decode<{ jti: string }>(token).jti;
    expect(jtiOf(first.refresh_token)).toBe(live[0]?.jti);
    expect(jtiOf(second.refresh_token)).toBe(live[0]?.jti);

    // "usable" means it works, not merely that it was returned: both access
    // tokens verify, and either refresh token can be redeemed from here — a
    // loser left holding a token that names no live row would pass every
    // assertion above and still be signed out at its next refresh
    for (const pair of [first, second]) {
      await expect(
        jwt.verifyAsync<{ typ: string }>(pair.access_token),
      ).resolves.toMatchObject({ typ: 'access', sub: userId });
    }
    const next = await service.refreshTokens(second.refresh_token);
    expect(jtiOf(next.refresh_token)).not.toBe(live[0]?.jti);
    // ...and the other tab, a moment later, replays that rotation as usual
    const replayed = await service.refreshTokens(first.refresh_token);
    expect(jtiOf(replayed.refresh_token)).toBe(jtiOf(next.refresh_token));
  });

  it('rejects an access token presented to the refresh flow (typ mismatch)', async () => {
    const { service, user } = await seedSession();
    const accessToken = await service.createAccessToken(claimsFor(user));

    await expect(service.refreshTokens(accessToken)).rejects.toThrow(
      'Invalid or expired token',
    );
  });
});

describe('SessionsService.logout (OS-467)', () => {
  it('revokes the refresh token family so it can no longer be redeemed', async () => {
    const service = await build();
    const user = await seedUser();
    const refreshToken = await service.createRefreshToken(
      claimsFor(user),
      randomUUID(),
    );

    await service.logout(refreshToken);

    await expect(service.refreshTokens(refreshToken)).rejects.toThrow(
      'Invalid or expired token',
    );
  });

  it('is a no-op for an unknown/invalid token (best-effort)', async () => {
    const service = await build();
    await expect(service.logout('not-a-real-token')).resolves.toBeUndefined();
  });
});

describe('SessionsService.revokeOthersAndRotate (OS-385)', () => {
  // what @CurrentUser() hands the controller — the caller's decoded access
  // token, which is what changePassword passes through
  function callerOf(user: Parameters<typeof claimsFor>[0]): AuthenticatedUser {
    return { ...claimsFor(user), typ: 'access' };
  }

  it('kills the token the caller presented along with every other session', async () => {
    const user = await seedUser();
    const service = await build();
    const callerToken = await service.createRefreshToken(
      claimsFor(user),
      randomUUID(),
    );
    const otherBrowserToken = await service.createRefreshToken(
      claimsFor(user),
      randomUUID(),
    );

    await service.revokeOthersAndRotate(callerOf(user), callerToken);
    await elapseGraceWindow(user.id);

    // the second browser is refused at its next rotation...
    await expect(service.refreshTokens(otherBrowserToken)).rejects.toThrow(
      'Invalid or expired token',
    );
    // ...and so is the caller's own old token, which is the point: a stolen
    // copy of it lives in the caller's family and would otherwise survive
    await expect(service.refreshTokens(callerToken)).rejects.toThrow(
      'Invalid or expired token',
    );
  });

  it('rotates the caller in place, leaving the replacement in the same family', async () => {
    const user = await seedUser();
    const service = await build();
    const callerToken = await service.createRefreshToken(
      claimsFor(user),
      randomUUID(),
    );

    await service.revokeOthersAndRotate(callerOf(user), callerToken);

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
    const callerToken = await service.createRefreshToken(
      claimsFor(user),
      randomUUID(),
    );
    await service.createRefreshToken(claimsFor(user), randomUUID());

    const [result] = await raceForRefreshRow(callerToken, 2, () =>
      Promise.all([
        service.revokeOthersAndRotate(callerOf(user), callerToken),
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
    const jwt = new JwtService({ secret: 'test-secret' });
    expect(live.map((r) => r.jti)).toEqual([
      jwt.decode<{ jti: string }>(result.refresh_token).jti,
    ]);

    const rotated = await service.refreshTokens(result.refresh_token);
    expect(typeof rotated.access_token).toBe('string');
  });

  it('revokes every session and starts a fresh one when there is no refresh cookie', async () => {
    const user = await seedUser();
    const service = await build();
    const someToken = await service.createRefreshToken(
      claimsFor(user),
      randomUUID(),
    );

    const result = await service.revokeOthersAndRotate(
      callerOf(user),
      undefined,
    );

    await expect(service.refreshTokens(someToken)).rejects.toThrow(
      'Invalid or expired token',
    );
    const rotated = await service.refreshTokens(result.refresh_token);
    expect(typeof rotated.access_token).toBe('string');
  });

  it("leaves another user's sessions alone", async () => {
    const user = await seedUser();
    const bystander = await seedUser();
    const service = await build();
    const bystanderToken = await service.createRefreshToken(
      claimsFor(bystander),
      randomUUID(),
    );

    await service.revokeOthersAndRotate(callerOf(user), undefined);

    const rotated = await service.refreshTokens(bystanderToken);
    expect(typeof rotated.access_token).toBe('string');
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

    await service.revokeOthersAndRotate(callerOf(user), undefined);

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
    const callerToken = await service.createRefreshToken(
      claimsFor(user),
      randomUUID(),
    );

    await service.revokeOtherSessions(user.id, callerToken);

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

    const rotated = await service.refreshTokens(callerToken);
    expect(typeof rotated.access_token).toBe('string');
  });

  it('refuses every other browser at its next refresh', async () => {
    const user = await seedUser();
    const service = await build();
    const callerToken = await service.createRefreshToken(
      claimsFor(user),
      randomUUID(),
    );
    const laptopToken = await service.createRefreshToken(
      claimsFor(user),
      randomUUID(),
    );
    const phoneToken = await service.createRefreshToken(
      claimsFor(user),
      randomUUID(),
    );

    await service.revokeOtherSessions(user.id, callerToken);
    // Without this the assertions below would pass for the wrong reason: a
    // token revoked moments ago is still inside the 10s replay window, where
    // refreshTokens deliberately hands back the replacement instead of
    // refusing. There is no replacement here, so it refuses either way — but
    // only after the window is a refusal evidence of revocation.
    await elapseGraceWindow(user.id);

    await expect(service.refreshTokens(laptopToken)).rejects.toThrow(
      'Invalid or expired token',
    );
    await expect(service.refreshTokens(phoneToken)).rejects.toThrow(
      'Invalid or expired token',
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
    const someToken = await service.createRefreshToken(
      claimsFor(user),
      randomUUID(),
    );

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
    const rotated = await service.refreshTokens(someToken);
    expect(typeof rotated.access_token).toBe('string');
  });

  it('refuses on a stale cookie too, rather than sparing the family it names', async () => {
    const user = await seedUser();
    const service = await build();
    const staleToken = await service.createRefreshToken(
      claimsFor(user),
      randomUUID(),
    );
    // this browser refreshed at some point, so the cookie it holds now is
    // the successor; `staleToken` is the rotated-out predecessor
    const { refresh_token: currentToken } =
      await service.refreshTokens(staleToken);
    const otherBrowser = await service.createRefreshToken(
      claimsFor(user),
      randomUUID(),
    );

    // A stale cookie is exactly what a browser someone else is holding might
    // present, so it must not be allowed to nominate a family to spare while
    // everything else dies. Liveness, not just ownership, decides whether
    // there's a "this one" — and without one the call does nothing at all.
    await expect(
      service.revokeOtherSessions(user.id, staleToken),
    ).rejects.toThrow(ConflictException);

    await elapseGraceWindow(user.id);
    const stillCurrent = await service.refreshTokens(currentToken);
    expect(typeof stillCurrent.access_token).toBe('string');
    const stillOther = await service.refreshTokens(otherBrowser);
    expect(typeof stillOther.access_token).toBe('string');
  });

  it("leaves another user's sessions alone", async () => {
    const user = await seedUser();
    const bystander = await seedUser();
    const service = await build();
    const callerToken = await service.createRefreshToken(
      claimsFor(user),
      randomUUID(),
    );
    const bystanderToken = await service.createRefreshToken(
      claimsFor(bystander),
      randomUUID(),
    );

    await service.revokeOtherSessions(user.id, callerToken);

    const rotated = await service.refreshTokens(bystanderToken);
    expect(typeof rotated.access_token).toBe('string');
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
    const callerToken = await service.createRefreshToken(
      claimsFor(user),
      randomUUID(),
    );

    await service.revokeOtherSessions(user.id, callerToken);

    const [row] = await db
      .select()
      .from(userRefreshTokensTable)
      .where(eq(userRefreshTokensTable.jti, 'already-revoked-jti'));
    expect(row?.revokedAt).toEqual(revokedAt);
  });
});
