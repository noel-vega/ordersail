import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { authenticator } from 'otplib';
import * as bcrypt from 'bcryptjs';
import { encryptMfaSecret } from 'src/shared/mfa/mfa-crypto';
import { hashToken } from 'src/shared/common/generate-token.util';
import {
  useTestDb,
  lockWaiters,
  liveRefreshTokenCount,
  deactivateUser,
  insertAccount,
  insertUser,
  insertUserPasswordReset,
  insertUserEmailVerification,
  insertUserInvite,
  insertUserMfa,
  insertUserMfaRecoveryCode,
  insertUserPasskey,
} from 'test-support';
import {
  PERMISSIONS_CATALOG,
  accountsTable,
  eq,
  permissionsTable,
  userEmailVerificationsTable,
  userInvitesTable,
  userMfaRecoveryCodesTable,
  userMfaTable,
  userPasswordResetsTable,
  userRefreshTokensTable,
  usersTable,
} from 'db/identity';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { EmailService } from 'src/shared/email/email.service';
import { AccountService } from '../account/account.service';
import { RolesService } from '../roles/roles.service';
import { UsersService } from '../users/users.service';
import { PermissionsService } from '../permissions/permissions.service';
import { AuthService } from './auth.service';
import { FactorStateService } from './factor-state.service';
import { SessionsService } from './sessions.service';
import {
  TEST_JWT_SECRET,
  UNGATED,
  callerOf,
  expectWorkingSession,
  presentAccessToken,
  raceForRefreshRow,
} from './sessions.spec-support';

const db = useTestDb();

// otplib's default verification window is 0: a code is only accepted inside
// its own 30s step. These specs generate a code and then do real work
// (bcrypt + a DB transaction) before the service verifies it, so a code
// generated with a second or two left on the clock can be rejected purely
// because the step rolled over — which is what flaked CI on OS-484. Waiting
// out the boundary first makes the timing irrelevant instead of unlikely.
//
// The production window is a separate question, filed as its own issue: a
// merchant whose phone clock drifts, or who types slowly, hits exactly this
// edge for real.
async function freshTotpCode(secret: string): Promise<string> {
  const remaining = authenticator.timeRemaining();
  if (remaining < 3) {
    await new Promise((resolve) => setTimeout(resolve, (remaining + 1) * 1000));
  }
  return authenticator.generate(secret);
}

const emailMock = {
  sendInviteEmail: jest.fn(),
  sendPasswordResetEmail: jest.fn(),
  sendVerificationEmail: jest.fn(),
};
beforeEach(() => {
  emailMock.sendInviteEmail.mockClear();
  emailMock.sendPasswordResetEmail.mockClear();
  emailMock.sendVerificationEmail.mockClear();
});

// The sign-in seam. AuthService proves who the caller is and ends by having
// SessionsService start their Session, so what comes back from a sign-in
// operation is a token pair — and the question these specs ask of one is
// whether it WORKS (the real guards take the access token, refresh takes the
// refresh token; see sessions.spec-support), never what it decodes to.
// `sessions` is handed back for that, and `users` for the specs where
// something about the User changes mid-Session. Specs that need neither use
// build().
async function buildBoth() {
  const ref = await Test.createTestingModule({
    providers: [
      AuthService,
      SessionsService,
      FactorStateService,
      { provide: DRIZZLE, useValue: db },
      {
        provide: JwtService,
        useValue: new JwtService({ secret: TEST_JWT_SECRET }),
      },
      // real UsersService (needed for requestPasswordReset's getByEmail) —
      // its EmailService/PermissionsService/SessionsService deps are unused on
      // that path
      {
        provide: UsersService,
        useValue: new UsersService(db, {} as never, {} as never, {} as never),
      },
      // real AccountService for signup's provision(), over a real RolesService
      // for createSystemRole (whose PermissionsService dep is unused on that path)
      {
        provide: AccountService,
        useValue: new AccountService(db, new RolesService(db, {} as never)),
      },
      // real PermissionsService — signup() doesn't call it, me() does
      { provide: PermissionsService, useValue: new PermissionsService(db) },
      { provide: EmailService, useValue: emailMock },
    ],
  }).compile();
  return {
    service: ref.get(AuthService),
    sessions: ref.get(SessionsService),
    users: ref.get(UsersService),
  };
}

async function userByEmail(email: string) {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email));
  if (!user) throw new Error(`no user with email ${email}`);
  return user;
}

async function build() {
  return (await buildBoth()).service;
}

const signupDto = {
  businessName: 'Cactus Coffee',
  firstName: 'Dana',
  lastName: 'Scully',
  email: 'dana@cactus.test',
  phone: '5555550100',
  password: 'supersecret',
};

describe('AuthService.signup (OS-173)', () => {
  // what gets seeded is AccountService.provision's suite (account.service.spec)
  it('provisions the account and leaves its first Owner signed in', async () => {
    await db.insert(permissionsTable).values(PERMISSIONS_CATALOG);
    const { service, sessions } = await buildBoth();

    const session = await service.signup(signupDto);

    const owner = await userByEmail(signupDto.email);
    expect(await callerOf(session.access_token)).toMatchObject({
      sub: owner.id,
      accountId: owner.accountId,
    });
    await expectWorkingSession(sessions, session, owner.id);
  });

  it('leaves the account unverified and sends a verification email (OS-470)', async () => {
    await db.insert(permissionsTable).values(PERMISSIONS_CATALOG);
    const service = await build();

    const session = await service.signup(signupDto);

    // signed in, but held at the email gate until the link is clicked...
    expect(await presentAccessToken(session.access_token)).toEqual({
      admitted: false,
      refusal: 'Email verification required',
    });
    // ...with the routes that get them verified still open to them
    expect(
      await presentAccessToken(session.access_token, UNGATED),
    ).toMatchObject({ admitted: true });

    const user = await userByEmail(signupDto.email);
    expect(user.emailVerifiedAt).toBeNull();

    const [verification] = await db
      .select()
      .from(userEmailVerificationsTable)
      .where(eq(userEmailVerificationsTable.userId, user.id));
    expect(verification).toBeDefined();
    expect(emailMock.sendVerificationEmail).toHaveBeenCalledWith(
      signupDto.email,
      expect.objectContaining({ firstName: signupDto.firstName }),
    );
  });

  // the translation itself is AccountService.provision's (account.service.spec)
  it('rejects a duplicate email with a ConflictException', async () => {
    const service = await build();
    await service.signup(signupDto);
    await expect(service.signup(signupDto)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  // signup used to catch a unique violation from anywhere in its body —
  // provisioning, the verification email, starting the Session — and call
  // it a duplicate email. Only one constraint means that. The error injected
  // here is shaped as drizzle really raises it: a query error whose `cause`
  // is the node-postgres error carrying the SQLSTATE and constraint name.
  it('does not report a unique violation from anywhere else as a duplicate email', async () => {
    const { service, sessions } = await buildBoth();
    const jtiCollision = Object.assign(new Error('Failed query: insert …'), {
      cause: Object.assign(
        new Error(
          'duplicate key value violates unique constraint "user_refresh_tokens_jti_key"',
        ),
        { code: '23505', constraint: 'user_refresh_tokens_jti_key' },
      ),
    });
    jest.spyOn(sessions, 'start').mockRejectedValueOnce(jtiCollision);

    await expect(service.signup(signupDto)).rejects.toBe(jtiCollision);
  });
});

describe('AuthService.me (OS-180)', () => {
  // The caller is whatever the real AuthGuard makes of the access token
  // signup handed out — the same thing @CurrentUser() gives the handler.
  async function signedUp(service: AuthService) {
    await db.insert(permissionsTable).values(PERMISSIONS_CATALOG);
    const { access_token } = await service.signup(signupDto);
    return { access_token, caller: await callerOf(access_token) };
  }

  it('returns identity + the caller effective permission keys', async () => {
    const service = await build();
    const { caller } = await signedUp(service);

    const me = await service.me(caller);

    expect(me).toMatchObject({
      userId: caller.sub,
      accountId: caller.accountId,
      email: signupDto.email,
      firstName: signupDto.firstName,
      lastName: signupDto.lastName,
      emailVerified: false,
      totpEnabled: false,
    });
    // fresh signup → Owner role → every catalog key, sorted
    expect(me.permissions).toEqual(
      [...PERMISSIONS_CATALOG.map((p) => p.key)].sort(),
    );
  });

  // The defect this fixes (OS-527): the name used to ride in the token, the
  // Profile edit never re-minted it, and every refresh copied the old value
  // forward — so the sidebar showed the old name until sign-out. Same access
  // token before and after: nothing about the token has to change for the
  // answer to.
  it('describes the User as they are now: a Profile edit shows up with the same access token', async () => {
    const { service, users } = await buildBoth();
    const { caller } = await signedUp(service);

    await users.updateProfile(caller.sub, caller.accountId, {
      firstName: 'Katherine',
      lastName: 'Scully-Mulder',
    });

    expect(await service.me(caller)).toMatchObject({
      userId: caller.sub,
      email: signupDto.email,
      firstName: 'Katherine',
      lastName: 'Scully-Mulder',
    });
  });

  // The two gate facts are the exception — they're reported as the token
  // has them, because that is what the guards will act on. Telling
  // merchant-web "verified" while the token still says otherwise would send
  // the caller into pages that 403 them.
  it('reports the gate claims as the presented token has them', async () => {
    const service = await build();
    const { caller } = await signedUp(service);
    await db
      .update(usersTable)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(usersTable.id, caller.sub));

    expect((await service.me(caller)).emailVerified).toBe(false);
  });

  it('refuses a caller whose User row is gone', async () => {
    const service = await build();
    const { caller } = await signedUp(service);
    await db.delete(usersTable).where(eq(usersTable.id, caller.sub));

    await expect(service.me(caller)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('reports totpEnabled: true once a factor is confirmed', async () => {
    const service = await build();
    const { caller } = await signedUp(service);
    await insertUserMfa(db, { userId: caller.sub, confirmedAt: new Date() });

    const me = await service.me(caller);

    expect(me.totpEnabled).toBe(true);
    expect(me.hasMfaFactor).toBe(true);
    expect(me.passkeyCount).toBe(0);
  });

  it('reports a passkey-only user as hasMfaFactor with totpEnabled false', async () => {
    const service = await build();
    const { caller } = await signedUp(service);
    await insertUserPasskey(db, { userId: caller.sub });
    await insertUserPasskey(db, { userId: caller.sub });

    const me = await service.me(caller);

    expect(me.totpEnabled).toBe(false);
    expect(me.passkeyCount).toBe(2);
    expect(me.hasMfaFactor).toBe(true);
  });
});

describe('AuthService.requestPasswordReset (OS-469)', () => {
  it('creates a reset row and emails the user for an active account', async () => {
    const account = await insertAccountFor();
    const user = await insertUser(db, {
      accountId: account.id,
      email: 'active@store.test',
      password: 'hashed',
    });
    const service = await build();

    await service.requestPasswordReset(user.email);

    const [reset] = await db
      .select()
      .from(userPasswordResetsTable)
      .where(eq(userPasswordResetsTable.userId, user.id));
    expect(reset).toBeDefined();
    expect(emailMock.sendPasswordResetEmail).toHaveBeenCalledWith(
      user.email,
      expect.objectContaining({ firstName: user.firstname }),
    );

    // OS-476: only the digest of the emailed token is stored
    const [, params] = emailMock.sendPasswordResetEmail.mock.calls[0] as [
      string,
      { resetUrl: string },
    ];
    const emailed = new URL(params.resetUrl).searchParams.get('token')!;
    expect(reset.token).not.toBe(emailed);
    expect(reset.token).toBe(hashToken(emailed));
  });

  it('replaces an existing pending reset instead of accumulating rows', async () => {
    const account = await insertAccountFor();
    const user = await insertUser(db, {
      accountId: account.id,
      email: 'active2@store.test',
      password: 'hashed',
    });
    const service = await build();

    await service.requestPasswordReset(user.email);
    await service.requestPasswordReset(user.email);

    const rows = await db
      .select()
      .from(userPasswordResetsTable)
      .where(eq(userPasswordResetsTable.userId, user.id));
    expect(rows).toHaveLength(1);
  });

  it('is a silent no-op for an unknown email (no account enumeration)', async () => {
    const service = await build();
    await expect(
      service.requestPasswordReset('nobody@store.test'),
    ).resolves.toBeUndefined();
    expect(emailMock.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('is a silent no-op for a pending invite (no password set yet)', async () => {
    const account = await insertAccountFor();
    const user = await insertUser(db, {
      accountId: account.id,
      email: 'invited@store.test',
      password: null,
    });
    const service = await build();

    await service.requestPasswordReset(user.email);

    expect(emailMock.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  async function insertAccountFor() {
    const [account] = await db
      .insert(accountsTable)
      .values({
        name: 'Reset Co',
        phone: '5555550100',
        email: 'reset-co@store.test',
      })
      .returning();
    if (!account) throw new Error('account insert returned no row');
    return account;
  }
});

describe('AuthService.resetPassword (OS-469)', () => {
  async function seedActiveUser(overrides: { password?: string } = {}) {
    const [account] = await db
      .insert(accountsTable)
      .values({
        name: 'Reset Co',
        phone: '5555550100',
        email: 'reset-co2@store.test',
      })
      .returning();
    if (!account) throw new Error('account insert returned no row');
    const user = await insertUser(db, {
      accountId: account.id,
      email: 'reset-user@store.test',
      password: overrides.password ?? 'old-hashed-password',
    });
    return user;
  }

  it('sets the new password, consumes the token, and revokes all sessions', async () => {
    const user = await seedActiveUser();
    const reset = await insertUserPasswordReset(db, { userId: user.id });
    // fixture returns the full row (not just the overridden raw token)
    expect(typeof reset.id).toBe('number');
    expect(reset.userId).toBe(user.id);
    expect(reset.expiresAt).toBeInstanceOf(Date);
    const { service, sessions } = await buildBoth();
    const laptop = await sessions.start(user.id);
    const phone = await sessions.start(user.id);

    await service.resetPassword(reset.token, 'brand-new-password');

    const [updated] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, user.id));
    expect(updated?.password).not.toBe(user.password);

    const remaining = await db
      .select()
      .from(userPasswordResetsTable)
      .where(eq(userPasswordResetsTable.userId, user.id));
    expect(remaining).toHaveLength(0);

    // whoever prompted the reset is signed out, on every browser
    await expect(sessions.refreshTokens(laptop.refresh_token)).rejects.toThrow(
      'Invalid or expired token',
    );
    await expect(sessions.refreshTokens(phone.refresh_token)).rejects.toThrow(
      'Invalid or expired token',
    );
  });

  // The reset exists to lock out whoever holds the old password's Sessions,
  // and their browser refreshes on every navigation — so the reset can land
  // while one of those refreshes has inserted a successor it hasn't
  // committed. That successor must not be what survives the reset. The
  // refresh is parked first, so it is the one in flight.
  it("ends a Session whose refresh was already in flight — an attacker's successor does not survive the reset", async () => {
    const user = await seedActiveUser();
    const reset = await insertUserPasswordReset(db, { userId: user.id });
    const { service, sessions } = await buildBoth();
    const attacker = await sessions.start(user.id);

    const [refreshed] = await raceForRefreshRow(
      db,
      attacker.refresh_token,
      2,
      async () => {
        const refreshing = sessions.refreshTokens(attacker.refresh_token);
        refreshing.catch(() => undefined);
        await lockWaiters(db, 1);
        return Promise.all([
          refreshing,
          service.resetPassword(reset.token, 'brand-new-password'),
        ]);
      },
    );

    await expect(
      sessions.refreshTokens(refreshed.refresh_token),
    ).rejects.toThrow('Invalid or expired token');
    expect(await liveRefreshTokenCount(db, user.id)).toBe(0);
  });

  it('rejects an expired token', async () => {
    const user = await seedActiveUser();
    const reset = await insertUserPasswordReset(db, {
      userId: user.id,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const service = await build();

    await expect(
      service.resetPassword(reset.token, 'brand-new-password'),
    ).rejects.toThrow('Invalid or expired token');
  });

  it('rejects a token that has already been used', async () => {
    const user = await seedActiveUser();
    const reset = await insertUserPasswordReset(db, { userId: user.id });
    const service = await build();

    await service.resetPassword(reset.token, 'brand-new-password');

    await expect(
      service.resetPassword(reset.token, 'another-password'),
    ).rejects.toThrow('Invalid or expired token');
  });

  it('rejects an unknown token', async () => {
    const service = await build();
    await expect(
      service.resetPassword('not-a-real-token', 'brand-new-password'),
    ).rejects.toThrow('Invalid or expired token');
  });
});

describe('AuthService.changePassword (OS-385)', () => {
  const CURRENT_PASSWORD = 'correct-horse-battery-staple';
  const NEW_PASSWORD = 'another-horse-another-staple';

  async function seedUser() {
    const account = await insertAccount(db, { name: 'Change Pw Co' });
    return insertUser(db, {
      accountId: account.id,
      password: await bcrypt.hash(CURRENT_PASSWORD, 10),
      emailVerifiedAt: new Date(),
    });
  }

  it('replaces the password: the old one stops verifying and the new one starts', async () => {
    const user = await seedUser();
    const service = await build();

    await service.changePassword(
      user.id,
      CURRENT_PASSWORD,
      NEW_PASSWORD,
      undefined,
    );

    await expect(
      service.verifyPassword(user.id, CURRENT_PASSWORD),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      service.verifyPassword(user.id, NEW_PASSWORD),
    ).resolves.toBeUndefined();
  });

  it('hands the caller a replacement that keeps them signed in', async () => {
    const user = await seedUser();
    const { service, sessions } = await buildBoth();
    const caller = await sessions.start(user.id);
    const otherBrowser = await sessions.start(user.id);

    const replacement = await service.changePassword(
      user.id,
      CURRENT_PASSWORD,
      NEW_PASSWORD,
      caller.refresh_token,
    );

    await expectWorkingSession(sessions, replacement, user.id);
    // ...and nobody else: the rest is SessionsService.revokeOthersAndRotate's
    // suite (sessions.service.spec)
    await expect(
      sessions.refreshTokens(otherBrowser.refresh_token),
    ).rejects.toThrow('Invalid or expired token');
  });

  // Story 17: "a stolen copy of my own token dies". An ordinary refresh
  // replays its successor to the rotated-out token for a few seconds, for
  // the sake of a second tab; a password change must not, or the copy it
  // exists to kill is good for one more redemption — which is all it needs.
  it("refuses a copy of the caller's old refresh token straight away, and ends the Session it was presented to", async () => {
    const user = await seedUser();
    const { service, sessions } = await buildBoth();
    const caller = await sessions.start(user.id);

    const replacement = await service.changePassword(
      user.id,
      CURRENT_PASSWORD,
      NEW_PASSWORD,
      caller.refresh_token,
    );

    // the thief, inside what would be the grace window
    await expect(sessions.refreshTokens(caller.refresh_token)).rejects.toThrow(
      'Invalid or expired token',
    );
    // reuse: the whole Session goes, the caller's replacement included
    await expect(
      sessions.refreshTokens(replacement.refresh_token),
    ).rejects.toThrow('Invalid or expired token');
  });

  it('rejects a wrong current password without touching the row or the sessions', async () => {
    const user = await seedUser();
    const { service, sessions } = await buildBoth();
    const caller = await sessions.start(user.id);

    await expect(
      service.changePassword(
        user.id,
        'not-the-current-password',
        NEW_PASSWORD,
        caller.refresh_token,
      ),
    ).rejects.toThrow('Current password is incorrect');

    await expect(
      service.verifyPassword(user.id, CURRENT_PASSWORD),
    ).resolves.toBeUndefined();
    await expectWorkingSession(sessions, caller, user.id);
  });
});

describe('AuthService.acceptInvite — email verification (OS-470)', () => {
  it('marks the account verified at activation, no separate step', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, {
      accountId: account.id,
      email: 'invitee@store.test',
      password: null,
    });
    const invite = await insertUserInvite(db, { userId: user.id });
    const { service, sessions } = await buildBoth();

    const session = await service.acceptInvite({
      token: invite.token,
      password: 'brand-new-password',
    });

    // signed in, and straight past the email gate — what still holds them is
    // the Factor they owe (OS-494, covered below), hence skipMfaEnrollment
    expect(
      await presentAccessToken(session.access_token, {
        skipMfaEnrollment: true,
      }),
    ).toMatchObject({ admitted: true, user: { sub: user.id } });
    await expectWorkingSession(sessions, session, user.id);

    const [updated] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, user.id));
    expect(updated?.emailVerifiedAt).not.toBeNull();
  });
});

// SessionsService.start would refuse an invited User switched off before
// they join, as it refuses every sign-in path — but by then accepting the
// invite has already written: a password, a verified email, the Factor
// requirement, and the invite consumed. So this path is refused up front,
// before any of that, and answered exactly like an invite that doesn't
// exist: the link tells nobody that the User behind it was deactivated.
describe('AuthService.acceptInvite — a deactivated User', () => {
  it('is refused like an invalid invite, with nothing written: no Session, no password, and the invite left in place', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, {
      accountId: account.id,
      email: 'switched-off@store.test',
      password: null,
    });
    const invite = await insertUserInvite(db, { userId: user.id });
    await deactivateUser(db, user.id);
    const service = await build();

    const refusal = await service
      .acceptInvite({ token: invite.token, password: 'brand-new-password' })
      .catch((err: unknown) => err);
    const unknownInvite = await service
      .acceptInvite({ token: 'no-such-invite', password: 'brand-new-password' })
      .catch((err: unknown) => err);

    expect(await db.select().from(userRefreshTokensTable)).toHaveLength(0);
    expect(await userByEmail('switched-off@store.test')).toMatchObject({
      password: null,
      emailVerifiedAt: null,
      factorRequiredAt: null,
    });
    expect(
      await db
        .select()
        .from(userInvitesTable)
        .where(eq(userInvitesTable.userId, user.id)),
    ).toHaveLength(1);

    expect(refusal).toBeInstanceOf(UnauthorizedException);
    expect(refusal).toEqual(unknownInvite);
  });
});

describe('AuthService.verifyEmail (OS-470)', () => {
  async function seedUnverifiedUser() {
    const account = await insertAccount(db);
    return insertUser(db, {
      accountId: account.id,
      email: 'unverified@store.test',
      password: 'hashed',
    });
  }

  it('verifies the caller and hands back an access token the email gate now accepts', async () => {
    const user = await seedUnverifiedUser();
    const verification = await insertUserEmailVerification(db, {
      userId: user.id,
    });
    expect(typeof verification.id).toBe('number');
    expect(verification.userId).toBe(user.id);
    expect(verification.expiresAt).toBeInstanceOf(Date);
    const { service, sessions } = await buildBoth();
    const session = await sessions.start(user.id);
    expect(await presentAccessToken(session.access_token)).toMatchObject({
      admitted: false,
    });

    const result = await service.verifyEmail(user.id, verification.token);

    expect(await presentAccessToken(result.access_token)).toMatchObject({
      admitted: true,
      user: { sub: user.id },
    });
    // a re-mint, not a new Session: the link proves inbox control, never
    // identity, so the body carries no refresh token and the Session the
    // caller already had simply carries on
    expect(result).toEqual({ access_token: expect.any(String) as string });
    expect(await db.select().from(userRefreshTokensTable)).toHaveLength(1);
    await expectWorkingSession(sessions, session, user.id);

    const [updated] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, user.id));
    expect(updated?.emailVerifiedAt).not.toBeNull();

    const remaining = await db
      .select()
      .from(userEmailVerificationsTable)
      .where(eq(userEmailVerificationsTable.userId, user.id));
    expect(remaining).toHaveLength(0);
  });

  it('rejects an expired token', async () => {
    const user = await seedUnverifiedUser();
    const verification = await insertUserEmailVerification(db, {
      userId: user.id,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const service = await build();

    await expect(
      service.verifyEmail(user.id, verification.token),
    ).rejects.toThrow('Invalid or expired token');
  });

  it('rejects an unknown token', async () => {
    const user = await seedUnverifiedUser();
    const service = await build();
    await expect(
      service.verifyEmail(user.id, 'not-a-real-token'),
    ).rejects.toThrow('Invalid or expired token');
  });

  it("rejects another user's token without consuming it", async () => {
    const owner = await seedUnverifiedUser();
    const other = await insertUser(db, {
      accountId: owner.accountId,
      email: 'someone-else@store.test',
      password: 'hashed',
    });
    const verification = await insertUserEmailVerification(db, {
      userId: owner.id,
    });
    const service = await build();

    await expect(
      service.verifyEmail(other.id, verification.token),
    ).rejects.toThrow('This verification link belongs to a different account');

    const [otherRow] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, other.id));
    expect(otherRow?.emailVerifiedAt).toBeNull();

    await expect(
      service.verifyEmail(owner.id, verification.token),
    ).resolves.toHaveProperty('access_token');
  });

  it('rejects a token that has already been used', async () => {
    const user = await seedUnverifiedUser();
    const verification = await insertUserEmailVerification(db, {
      userId: user.id,
    });
    const service = await build();

    await service.verifyEmail(user.id, verification.token);

    await expect(
      service.verifyEmail(user.id, verification.token),
    ).rejects.toThrow('Invalid or expired token');
  });
});

describe('AuthService.resendVerification (OS-470)', () => {
  it('regenerates the token and resends for an unverified account', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, {
      accountId: account.id,
      email: 'resend@store.test',
      password: 'hashed',
    });
    const service = await build();

    await service.resendVerification(user.id);

    const [verification] = await db
      .select()
      .from(userEmailVerificationsTable)
      .where(eq(userEmailVerificationsTable.userId, user.id));
    expect(verification).toBeDefined();
    expect(emailMock.sendVerificationEmail).toHaveBeenCalledWith(
      user.email,
      expect.objectContaining({ firstName: user.firstname }),
    );

    // OS-476: only the digest of the emailed token is stored
    const [, params] = emailMock.sendVerificationEmail.mock.calls[0] as [
      string,
      { verifyUrl: string },
    ];
    const emailed = new URL(params.verifyUrl).searchParams.get('token')!;
    expect(verification.token).not.toBe(emailed);
    expect(verification.token).toBe(hashToken(emailed));
  });

  it('replaces an existing pending verification instead of accumulating rows', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, {
      accountId: account.id,
      email: 'resend2@store.test',
      password: 'hashed',
    });
    const service = await build();

    await service.resendVerification(user.id);
    await service.resendVerification(user.id);

    const rows = await db
      .select()
      .from(userEmailVerificationsTable)
      .where(eq(userEmailVerificationsTable.userId, user.id));
    expect(rows).toHaveLength(1);
  });

  it('is a silent no-op for an already-verified account', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, {
      accountId: account.id,
      email: 'already-verified@store.test',
      password: 'hashed',
      emailVerifiedAt: new Date(),
    });
    const service = await build();

    await service.resendVerification(user.id);

    expect(emailMock.sendVerificationEmail).not.toHaveBeenCalled();
  });
});

describe('AuthService — TOTP MFA (OS-316)', () => {
  const password = 'correct-horse-battery-staple';

  async function seedUserWithPassword(
    opts: { emailVerifiedAt?: Date | null } = {},
  ) {
    const account = await insertAccount(db);
    return insertUser(db, {
      accountId: account.id,
      email: `mfa-${randomUUID()}@store.test`,
      password: await bcrypt.hash(password, 10),
      // ?? would treat an explicit `null` the same as "omitted" and fall
      // through to the default — use `in` so a test can seed an
      // unverified user on purpose
      emailVerifiedAt:
        'emailVerifiedAt' in opts ? opts.emailVerifiedAt : new Date(),
    });
  }

  function extractSecret(otpauthUrl: string): string {
    const secret = new URL(otpauthUrl).searchParams.get('secret');
    if (!secret) throw new Error('otpauth URL had no secret');
    return secret;
  }

  describe('signin', () => {
    it('starts a Session on the password alone when no MFA is enrolled', async () => {
      const user = await seedUserWithPassword();
      const { service, sessions } = await buildBoth();

      const result = await service.signin({ email: user.email, password });

      if (result.mfaRequired) throw new Error('expected a normal sign-in');
      expect(await presentAccessToken(result.access_token)).toMatchObject({
        admitted: true,
        user: { sub: user.id, accountId: user.accountId },
      });
      await expectWorkingSession(sessions, result, user.id);
    });

    it('signs an unverified User in, held at the email gate', async () => {
      const user = await seedUserWithPassword({ emailVerifiedAt: null });
      const service = await build();

      const result = await service.signin({ email: user.email, password });

      if (result.mfaRequired) throw new Error('expected a normal sign-in');
      expect(await presentAccessToken(result.access_token)).toEqual({
        admitted: false,
        refusal: 'Email verification required',
      });
    });

    it('refuses a deactivated User, and starts no Session', async () => {
      const user = await seedUserWithPassword();
      await deactivateUser(db, user.id);
      const service = await build();

      await expect(
        service.signin({ email: user.email, password }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(await db.select().from(userRefreshTokensTable)).toHaveLength(0);
    });

    it('signs in normally when MFA is enrolled but never confirmed', async () => {
      const user = await seedUserWithPassword();
      await insertUserMfa(db, { userId: user.id });
      const service = await build();

      const result = await service.signin({ email: user.email, password });

      expect(result.mfaRequired).toBe(false);
    });

    it('returns a challenge instead of tokens when MFA is confirmed', async () => {
      const user = await seedUserWithPassword();
      await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
      const service = await build();

      const result = await service.signin({ email: user.email, password });

      expect(result.mfaRequired).toBe(true);
      if (!result.mfaRequired) throw new Error('expected a challenge');
      expect(result.challengeToken).toBeTruthy();
      // a password accepted with a Factor still owed is not a Session
      expect(result).not.toHaveProperty('access_token');
      expect(result).not.toHaveProperty('refresh_token');
      expect(await db.select().from(userRefreshTokensTable)).toHaveLength(0);
    });

    // The challenge token is a signed JWT too — it must open nothing.
    it('issues a challenge token that works neither as an access token nor as a refresh token', async () => {
      const user = await seedUserWithPassword();
      await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
      const { service, sessions } = await buildBoth();

      const result = await service.signin({ email: user.email, password });
      if (!result.mfaRequired) throw new Error('expected a challenge');

      expect(
        await presentAccessToken(result.challengeToken, UNGATED),
      ).toMatchObject({ admitted: false });
      await expect(
        sessions.refreshTokens(result.challengeToken),
      ).rejects.toThrow('Invalid or expired token');
    });

    it('still rejects a wrong password before ever checking MFA', async () => {
      const user = await seedUserWithPassword();
      await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
      const service = await build();

      await expect(
        service.signin({ email: user.email, password: 'wrong' }),
      ).rejects.toThrow();
    });
  });

  describe('enrollMfa', () => {
    it('requires a verified email', async () => {
      const user = await seedUserWithPassword({ emailVerifiedAt: null });
      const service = await build();

      await expect(service.enrollMfa(user.id)).rejects.toThrow(
        'Verify your email before enabling MFA',
      );
    });

    it('generates a pending, encrypted secret and returns an otpauth URI', async () => {
      const user = await seedUserWithPassword();
      const service = await build();

      const result = await service.enrollMfa(user.id);
      expect(result.otpauthUrl).toContain('otpauth://totp/');
      // the label the authenticator app shows is the User's email as it is
      // in the row now — enrollMfa takes an id, not a token's copy of it
      expect(decodeURIComponent(result.otpauthUrl)).toContain(user.email);

      const [mfa] = await db
        .select()
        .from(userMfaTable)
        .where(eq(userMfaTable.userId, user.id));
      expect(mfa?.confirmedAt).toBeNull();
      expect(mfa?.secret).not.toBe(extractSecret(result.otpauthUrl));
    });

    it('rejects re-enrolling over an already-confirmed factor', async () => {
      const user = await seedUserWithPassword();
      await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
      const service = await build();

      await expect(service.enrollMfa(user.id)).rejects.toThrow(
        'MFA is already enabled',
      );
    });
  });

  describe('confirmMfa', () => {
    it('rejects when there is no pending enrollment', async () => {
      const user = await seedUserWithPassword();
      const service = await build();

      await expect(
        service.confirmMfa(user.id, '123456', password),
      ).rejects.toThrow('No pending MFA enrollment');
    });

    it('rejects an invalid code', async () => {
      const user = await seedUserWithPassword();
      const service = await build();
      await service.enrollMfa(user.id);

      await expect(
        service.confirmMfa(user.id, '000000', password),
      ).rejects.toThrow('Invalid code');
    });

    it('rejects the wrong password, even with a correct code', async () => {
      const user = await seedUserWithPassword();
      const service = await build();
      const { otpauthUrl } = await service.enrollMfa(user.id);
      const code = await freshTotpCode(extractSecret(otpauthUrl));

      await expect(
        service.confirmMfa(user.id, code, 'wrong-password'),
      ).rejects.toThrow();

      const [mfa] = await db
        .select()
        .from(userMfaTable)
        .where(eq(userMfaTable.userId, user.id));
      expect(mfa?.confirmedAt).toBeNull();
    });

    it('activates the factor and returns one batch of recovery codes', async () => {
      const user = await seedUserWithPassword();
      const service = await build();
      const { otpauthUrl } = await service.enrollMfa(user.id);
      const code = await freshTotpCode(extractSecret(otpauthUrl));

      const { recoveryCodes } = await service.confirmMfa(
        user.id,
        code,
        password,
      );

      expect(recoveryCodes).toHaveLength(10);
      const [mfa] = await db
        .select()
        .from(userMfaTable)
        .where(eq(userMfaTable.userId, user.id));
      expect(mfa?.confirmedAt).not.toBeNull();
    });

    // A caller gated into forced enrollment holds an access token that says
    // so. Enrolling must unstick them at once, not at their next refresh.
    it('re-mints an access token the enrollment gate now accepts', async () => {
      const user = await seedUserWithPassword();
      await db
        .update(usersTable)
        .set({ factorRequiredAt: new Date() })
        .where(eq(usersTable.id, user.id));
      const { service, sessions } = await buildBoth();
      const session = await sessions.start(user.id);
      expect(await presentAccessToken(session.access_token)).toEqual({
        admitted: false,
        refusal: 'MFA enrollment required',
      });
      const { otpauthUrl } = await service.enrollMfa(user.id);

      const { access_token } = await service.confirmMfa(
        user.id,
        await freshTotpCode(extractSecret(otpauthUrl)),
        password,
      );

      expect(await presentAccessToken(access_token)).toMatchObject({
        admitted: true,
        user: { sub: user.id },
      });
    });

    // Adding a Factor only strengthens sign-in, so nobody is signed out for
    // it — the opposite of disableMfa below.
    it("leaves the User's other Sessions alive (OS-554)", async () => {
      const user = await seedUserWithPassword();
      const { service, sessions } = await buildBoth();
      const otherBrowser = await sessions.start(user.id);
      const { otpauthUrl } = await service.enrollMfa(user.id);

      await service.confirmMfa(
        user.id,
        await freshTotpCode(extractSecret(otpauthUrl)),
        password,
      );

      await expectWorkingSession(sessions, otherBrowser, user.id);
    });
  });

  describe('verifyMfaChallenge', () => {
    it('completes a full enroll → challenge → verify round trip with a TOTP code', async () => {
      const user = await seedUserWithPassword();
      const { service, sessions } = await buildBoth();
      const { otpauthUrl } = await service.enrollMfa(user.id);
      const secret = extractSecret(otpauthUrl);
      await service.confirmMfa(user.id, await freshTotpCode(secret), password);

      const signInResult = await service.signin({
        email: user.email,
        password,
      });
      if (!signInResult.mfaRequired) throw new Error('expected a challenge');

      const result = await service.verifyMfaChallenge(
        signInResult.challengeToken,
        await freshTotpCode(secret),
      );

      // proving the Factor is what starts the Session
      expect(await presentAccessToken(result.access_token)).toMatchObject({
        admitted: true,
        user: { sub: user.id },
      });
      await expectWorkingSession(sessions, result, user.id);
    });

    it('accepts an unused recovery code exactly once', async () => {
      const user = await seedUserWithPassword();
      // a real, decryptable secret — the TOTP check runs (and fails) before
      // falling through to the recovery-code path, so it must decrypt cleanly
      await insertUserMfa(db, {
        userId: user.id,
        confirmedAt: new Date(),
        secret: encryptMfaSecret(authenticator.generateSecret()),
      });
      const recoveryCode = 'ABCDE-FGHJK';
      await insertUserMfaRecoveryCode(db, {
        userId: user.id,
        codeHash: await bcrypt.hash(recoveryCode, 10),
      });
      const service = await build();

      const first = await service.signin({ email: user.email, password });
      if (!first.mfaRequired) throw new Error('expected a challenge');
      const result = await service.verifyMfaChallenge(
        first.challengeToken,
        recoveryCode,
      );
      expect(result.access_token).toBeTruthy();

      const second = await service.signin({ email: user.email, password });
      if (!second.mfaRequired) throw new Error('expected a challenge');
      await expect(
        service.verifyMfaChallenge(second.challengeToken, recoveryCode),
      ).rejects.toThrow('Invalid code');
    });

    it('lets only one of two concurrent redemptions of the same code succeed', async () => {
      const user = await seedUserWithPassword();
      await insertUserMfa(db, {
        userId: user.id,
        confirmedAt: new Date(),
        secret: encryptMfaSecret(authenticator.generateSecret()),
      });
      const recoveryCode = 'ABCDE-FGHJK';
      await insertUserMfaRecoveryCode(db, {
        userId: user.id,
        codeHash: await bcrypt.hash(recoveryCode, 10),
      });
      const service = await build();

      const challenge = await service.signin({ email: user.email, password });
      if (!challenge.mfaRequired) throw new Error('expected a challenge');

      // same challenge token, same recovery code, fired concurrently — the
      // race this guards against
      const results = await Promise.allSettled([
        service.verifyMfaChallenge(challenge.challengeToken, recoveryCode),
        service.verifyMfaChallenge(challenge.challengeToken, recoveryCode),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const codeRows = await db
        .select()
        .from(userMfaRecoveryCodesTable)
        .where(eq(userMfaRecoveryCodesTable.userId, user.id));
      expect(codeRows.filter((r) => r.usedAt !== null)).toHaveLength(1);
    });

    it('rejects an invalid code', async () => {
      const user = await seedUserWithPassword();
      await insertUserMfa(db, {
        userId: user.id,
        confirmedAt: new Date(),
        secret: encryptMfaSecret(authenticator.generateSecret()),
      });
      const service = await build();
      const signInResult = await service.signin({
        email: user.email,
        password,
      });
      if (!signInResult.mfaRequired) throw new Error('expected a challenge');

      await expect(
        service.verifyMfaChallenge(signInResult.challengeToken, '000000'),
      ).rejects.toThrow('Invalid code');
    });

    it('rejects an unknown/expired challenge token', async () => {
      const service = await build();

      await expect(
        service.verifyMfaChallenge('not-a-real-token', '123456'),
      ).rejects.toThrow('Invalid or expired challenge');
    });

    it("rejects a Session's own tokens presented as a challenge token", async () => {
      const user = await seedUserWithPassword();
      const { service, sessions } = await buildBoth();
      const session = await sessions.start(user.id);

      await expect(
        service.verifyMfaChallenge(session.access_token, '123456'),
      ).rejects.toThrow('Invalid or expired challenge');
      await expect(
        service.verifyMfaChallenge(session.refresh_token, '123456'),
      ).rejects.toThrow('Invalid or expired challenge');
    });

    // The challenge token outlives the password check by up to five minutes,
    // so deactivation has to be re-read when it's exchanged — the password
    // step passing earlier says nothing about the User now (OS-504). Same
    // message as every other challenge failure: no oracle.
    it('refuses a Session to a User deactivated mid-challenge', async () => {
      const user = await seedUserWithPassword();
      const service = await build();
      const { otpauthUrl } = await service.enrollMfa(user.id);
      const secret = extractSecret(otpauthUrl);
      await service.confirmMfa(user.id, await freshTotpCode(secret), password);

      const signInResult = await service.signin({
        email: user.email,
        password,
      });
      if (!signInResult.mfaRequired) throw new Error('expected a challenge');

      await db
        .update(usersTable)
        .set({ deactivatedAt: new Date() })
        .where(eq(usersTable.id, user.id));

      const attempt = service.verifyMfaChallenge(
        signInResult.challengeToken,
        await freshTotpCode(secret),
      );
      await expect(attempt).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(attempt).rejects.toThrow('Invalid or expired challenge');
    });

    it('does not burn the recovery code of a User deactivated mid-challenge', async () => {
      const user = await seedUserWithPassword();
      await insertUserMfa(db, {
        userId: user.id,
        confirmedAt: new Date(),
        secret: encryptMfaSecret(authenticator.generateSecret()),
      });
      const recoveryCode = 'ABCDE-FGHJK';
      await insertUserMfaRecoveryCode(db, {
        userId: user.id,
        codeHash: await bcrypt.hash(recoveryCode, 10),
      });
      const service = await build();

      const challenge = await service.signin({ email: user.email, password });
      if (!challenge.mfaRequired) throw new Error('expected a challenge');

      await db
        .update(usersTable)
        .set({ deactivatedAt: new Date() })
        .where(eq(usersTable.id, user.id));

      await expect(
        service.verifyMfaChallenge(challenge.challengeToken, recoveryCode),
      ).rejects.toThrow('Invalid or expired challenge');

      const codeRows = await db
        .select()
        .from(userMfaRecoveryCodesTable)
        .where(eq(userMfaRecoveryCodesTable.userId, user.id));
      expect(codeRows.every((r) => r.usedAt === null)).toBe(true);
    });
  });

  describe('disableMfa', () => {
    it('requires the current password', async () => {
      const user = await seedUserWithPassword();
      await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
      const service = await build();

      await expect(
        service.disableMfa(user.id, 'wrong-password', undefined),
      ).rejects.toThrow();
    });

    it('removes the MFA row and every recovery code on success', async () => {
      const user = await seedUserWithPassword();
      await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
      await insertUserMfaRecoveryCode(db, { userId: user.id });
      const service = await build();

      await service.disableMfa(user.id, password, undefined);

      const mfaRows = await db
        .select()
        .from(userMfaTable)
        .where(eq(userMfaTable.userId, user.id));
      expect(mfaRows).toHaveLength(0);

      const codeRows = await db
        .select()
        .from(userMfaRecoveryCodesTable)
        .where(eq(userMfaRecoveryCodesTable.userId, user.id));
      expect(codeRows).toHaveLength(0);
    });

    it('refuses to disable while the account requires MFA (OS-473)', async () => {
      const user = await seedUserWithPassword();
      await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
      await db
        .update(accountsTable)
        .set({ requireMfaAt: new Date() })
        .where(eq(accountsTable.id, user.accountId));
      const service = await build();

      await expect(
        service.disableMfa(user.id, password, undefined),
      ).rejects.toThrow('Your account requires MFA');

      const mfaRows = await db
        .select()
        .from(userMfaTable)
        .where(eq(userMfaTable.userId, user.id));
      expect(mfaRows).toHaveLength(1);
    });

    // The invited-staff stamp is the other source of the same rule: with no
    // account-wide policy at all, the per-user requirement still holds the
    // last factor in place — otherwise a staff member enrolls at the join
    // gate, removes it a minute later, and the gate was theatre.
    it('refuses to disable the last factor while factor_required_at is set (OS-494)', async () => {
      const user = await seedUserWithPassword();
      await db
        .update(usersTable)
        .set({ factorRequiredAt: new Date() })
        .where(eq(usersTable.id, user.id));
      await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
      const service = await build();

      await expect(
        service.disableMfa(user.id, password, undefined),
      ).rejects.toThrow(ConflictException);

      const mfaRows = await db
        .select()
        .from(userMfaTable)
        .where(eq(userMfaTable.userId, user.id));
      expect(mfaRows).toHaveLength(1);
    });

    // Sibling to the case above, not a replacement: the rule is "don't go to
    // zero factors", and since OS-485 a passkey is one. Someone holding both
    // can drop TOTP and still satisfy the account-wide requirement.
    it('allows disabling TOTP when a passkey remains (OS-485)', async () => {
      const user = await seedUserWithPassword();
      await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
      await insertUserPasskey(db, { userId: user.id });
      await db
        .update(accountsTable)
        .set({ requireMfaAt: new Date() })
        .where(eq(accountsTable.id, user.accountId));
      const service = await build();

      await service.disableMfa(user.id, password, undefined);

      const mfaRows = await db
        .select()
        .from(userMfaTable)
        .where(eq(userMfaTable.userId, user.id));
      expect(mfaRows).toHaveLength(0);
    });

    // Removing a Factor is a credential change, the same kind of event as
    // changing the password: whoever else is signed in may be the reason it's
    // being removed. The sweep itself is SessionsService.revokeOthersAndRotate's
    // suite (sessions.service.spec); these pin that disableMfa reaches it, and
    // when.
    describe('the Sessions it ends (OS-554)', () => {
      it("ends the User's other Sessions and rotates the caller's", async () => {
        const user = await seedUserWithPassword();
        await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
        const { service, sessions } = await buildBoth();
        const caller = await sessions.start(user.id);
        const otherBrowser = await sessions.start(user.id);

        const replacement = await service.disableMfa(
          user.id,
          password,
          caller.refresh_token,
        );

        await expect(
          sessions.refreshTokens(otherBrowser.refresh_token),
        ).rejects.toThrow('Invalid or expired token');
        // rotated, not spared: the token the caller walked in with is retired
        // and the one handed back is the only live one the User has
        expect(replacement.refresh_token).not.toBe(caller.refresh_token);
        expect(await liveRefreshTokenCount(db, user.id)).toBe(1);
        await expectWorkingSession(sessions, replacement, user.id);
      });

      it('starts a fresh Session when no cookie is presented, and nothing else survives', async () => {
        const user = await seedUserWithPassword();
        await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
        const { service, sessions } = await buildBoth();
        const someBrowser = await sessions.start(user.id);

        const fresh = await service.disableMfa(user.id, password, undefined);

        await expect(
          sessions.refreshTokens(someBrowser.refresh_token),
        ).rejects.toThrow('Invalid or expired token');
        expect(await liveRefreshTokenCount(db, user.id)).toBe(1);
        await expectWorkingSession(sessions, fresh, user.id);
      });

      // Order matters: a refused removal changed no credential, so it must
      // not cost anyone their Session either.
      it('touches no Session when the last-Factor rule refuses', async () => {
        const user = await seedUserWithPassword();
        await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
        await db
          .update(accountsTable)
          .set({ requireMfaAt: new Date() })
          .where(eq(accountsTable.id, user.accountId));
        const { service, sessions } = await buildBoth();
        const caller = await sessions.start(user.id);
        const otherBrowser = await sessions.start(user.id);

        await expect(
          service.disableMfa(user.id, password, caller.refresh_token),
        ).rejects.toThrow(ConflictException);

        await expectWorkingSession(sessions, caller, user.id);
        await expectWorkingSession(sessions, otherBrowser, user.id);
      });

      it('touches no Session on a wrong password', async () => {
        const user = await seedUserWithPassword();
        await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
        const { service, sessions } = await buildBoth();
        const caller = await sessions.start(user.id);
        const otherBrowser = await sessions.start(user.id);

        await expect(
          service.disableMfa(user.id, 'wrong-password', caller.refresh_token),
        ).rejects.toThrow(UnauthorizedException);

        await expectWorkingSession(sessions, caller, user.id);
        await expectWorkingSession(sessions, otherBrowser, user.id);
      });
    });
  });

  describe('regenerateRecoveryCodes', () => {
    it('requires an already-confirmed factor', async () => {
      const user = await seedUserWithPassword();
      const service = await build();

      await expect(
        service.regenerateRecoveryCodes(user.id, password),
      ).rejects.toThrow('MFA is not enabled');
    });

    it('requires the current password', async () => {
      const user = await seedUserWithPassword();
      await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
      const service = await build();

      await expect(
        service.regenerateRecoveryCodes(user.id, 'wrong-password'),
      ).rejects.toThrow();
    });

    it('replaces existing codes with a fresh batch of 10', async () => {
      const user = await seedUserWithPassword();
      await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
      await insertUserMfaRecoveryCode(db, { userId: user.id });
      const service = await build();

      const { recoveryCodes } = await service.regenerateRecoveryCodes(
        user.id,
        password,
      );
      expect(recoveryCodes).toHaveLength(10);

      const rows = await db
        .select()
        .from(userMfaRecoveryCodesTable)
        .where(eq(userMfaRecoveryCodesTable.userId, user.id));
      expect(rows).toHaveLength(10);
    });
  });
});

// Before passkeys, recovery codes were reachable only through a confirmed
// TOTP factor — a passkey-only user could never regenerate them.
describe('AuthService.regenerateRecoveryCodes — any factor (OS-485)', () => {
  const password = 'correct-horse-battery-staple';

  it('works for a passkey-only user', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, {
      accountId: account.id,
      password: await bcrypt.hash(password, 10),
      emailVerifiedAt: new Date(),
    });
    await insertUserPasskey(db, { userId: user.id });
    const service = await build();

    const { recoveryCodes } = await service.regenerateRecoveryCodes(
      user.id,
      password,
    );

    expect(recoveryCodes).toHaveLength(10);
  });

  it('still refuses for a user with no factor at all', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, {
      accountId: account.id,
      password: await bcrypt.hash(password, 10),
      emailVerifiedAt: new Date(),
    });
    const service = await build();

    await expect(
      service.regenerateRecoveryCodes(user.id, password),
    ).rejects.toThrow('MFA is not enabled');
  });
});

// Whether a brand-new Session is held at the enrollment gate. A Factor can be
// required of a User from two places — the account-wide policy an Owner
// switches on (OS-473) and the stamp an invited staff User gets on joining
// (OS-494) — and every sign-in path has to come out agreeing with the rule,
// which they now do by construction: none of them computes the claim, they
// all start the Session and SessionsService does. What happens to the claim
// LATER in the Session (a refresh noticing the policy turned on, a Factor
// enrolled or removed) is sessions.service.spec's.
describe('AuthService — the Factor requirement on a new Session (OS-473/OS-494)', () => {
  const password = 'correct-horse-battery-staple';
  const HELD = { admitted: false, refusal: 'MFA enrollment required' };

  async function seedAccountAndUser(opts: {
    requireMfaAt?: Date | null;
    factorRequiredAt?: Date;
  }) {
    const account = await insertAccount(db);
    if (opts.requireMfaAt !== undefined) {
      await db
        .update(accountsTable)
        .set({ requireMfaAt: opts.requireMfaAt })
        .where(eq(accountsTable.id, account.id));
    }
    const user = await insertUser(db, {
      accountId: account.id,
      email: `mfa-enforce-${randomUUID()}@store.test`,
      password: await bcrypt.hash(password, 10),
      emailVerifiedAt: new Date(),
      ...(opts.factorRequiredAt
        ? { factorRequiredAt: opts.factorRequiredAt }
        : {}),
    });
    return { account, user };
  }

  describe('password sign-in', () => {
    it('is past the gate when nothing requires a Factor', async () => {
      const { user } = await seedAccountAndUser({});
      const service = await build();

      const result = await service.signin({ email: user.email, password });

      if (result.mfaRequired) throw new Error('expected a normal sign-in');
      expect(await presentAccessToken(result.access_token)).toMatchObject({
        admitted: true,
      });
    });

    it('is held at the gate when the account requires MFA and the user has not enrolled', async () => {
      const { user } = await seedAccountAndUser({ requireMfaAt: new Date() });
      const { service, sessions } = await buildBoth();

      const result = await service.signin({ email: user.email, password });

      if (result.mfaRequired) throw new Error('expected a normal sign-in');
      expect(await presentAccessToken(result.access_token)).toEqual(HELD);
      // still signs in — this is a post-login gate, not a hard block, and
      // the routes that let them enroll skip it
      expect(
        await presentAccessToken(result.access_token, {
          skipMfaEnrollment: true,
        }),
      ).toMatchObject({ admitted: true });
      await expectWorkingSession(sessions, result, user.id);
    });

    // The invited-staff stamp is the other source of the same rule: no
    // account-wide policy at all, and the gate still stands.
    it('is held at the gate for a joined staff member with no factor (OS-494)', async () => {
      const { user } = await seedAccountAndUser({
        factorRequiredAt: new Date(),
      });
      const service = await build();

      const result = await service.signin({ email: user.email, password });

      if (result.mfaRequired) throw new Error('expected a normal sign-in');
      expect(await presentAccessToken(result.access_token)).toEqual(HELD);
    });

    it('still issues a challenge (unaffected by the account toggle) once the user has a confirmed factor', async () => {
      const { user } = await seedAccountAndUser({ requireMfaAt: new Date() });
      await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
      const service = await build();

      const result = await service.signin({ email: user.email, password });

      expect(result.mfaRequired).toBe(true);
    });
  });

  describe('challenge completion', () => {
    it('is past the gate after completing the challenge, even when the account requires MFA', async () => {
      const { user } = await seedAccountAndUser({ requireMfaAt: new Date() });
      const secret = authenticator.generateSecret();
      await insertUserMfa(db, {
        userId: user.id,
        confirmedAt: new Date(),
        secret: encryptMfaSecret(secret),
      });
      const service = await build();

      const signInResult = await service.signin({
        email: user.email,
        password,
      });
      if (!signInResult.mfaRequired) throw new Error('expected a challenge');

      const session = await service.verifyMfaChallenge(
        signInResult.challengeToken,
        await freshTotpCode(secret),
      );

      expect(await presentAccessToken(session.access_token)).toMatchObject({
        admitted: true,
        user: { sub: user.id },
      });
    });
  });

  describe('acceptInvite', () => {
    it('is held at the gate when the account already requires MFA at invite-accept time', async () => {
      const account = await insertAccount(db);
      await db
        .update(accountsTable)
        .set({ requireMfaAt: new Date() })
        .where(eq(accountsTable.id, account.id));
      const user = await insertUser(db, {
        accountId: account.id,
        password: null,
      });
      const invite = await insertUserInvite(db, { userId: user.id });
      const service = await build();

      const session = await service.acceptInvite({
        token: invite.token,
        password: 'brand-new-password',
      });

      expect(await presentAccessToken(session.access_token)).toEqual(HELD);
    });

    // Was "is satisfied when the account does not require MFA" until OS-494:
    // joining staff are now gated on their own, whatever the account policy.
    it('stamps factor_required_at and is held at the gate even when the account does not require MFA (OS-494)', async () => {
      const account = await insertAccount(db);
      const user = await insertUser(db, {
        accountId: account.id,
        password: null,
      });
      const invite = await insertUserInvite(db, { userId: user.id });
      const { service, sessions } = await buildBoth();

      const session = await service.acceptInvite({
        token: invite.token,
        password: 'brand-new-password',
      });

      expect(await presentAccessToken(session.access_token)).toEqual(HELD);

      const [row] = await db
        .select({ factorRequiredAt: usersTable.factorRequiredAt })
        .from(usersTable)
        .where(eq(usersTable.id, user.id));
      expect(row.factorRequiredAt).toBeInstanceOf(Date);

      // The whole reason the column exists: merchant-web refreshes on every
      // navigation, and a claim that wasn't backed by stored state flipped
      // to satisfied here, one click after joining.
      const next = await sessions.refreshTokens(session.refresh_token);
      expect(await presentAccessToken(next.access_token)).toEqual(HELD);
    });
  });

  describe('signup', () => {
    // Owners explore freely and are gated at the money actions instead
    // (OS-492) — signup must never stamp the column, and a refresh must not
    // start gating them either. (Past the email gate, that is: a fresh Owner
    // is still unverified, which is a different gate.)
    it('leaves an owner who signs up ungated, across a refresh too', async () => {
      await db.insert(permissionsTable).values(PERMISSIONS_CATALOG);
      const { service, sessions } = await buildBoth();
      const enrolledOnly = { skipEmailVerification: true };

      const session = await service.signup(signupDto);

      expect(
        await presentAccessToken(session.access_token, enrolledOnly),
      ).toMatchObject({ admitted: true });
      const owner = await userByEmail(signupDto.email);
      expect(owner.factorRequiredAt).toBeNull();

      const next = await sessions.refreshTokens(session.refresh_token);
      expect(
        await presentAccessToken(next.access_token, enrolledOnly),
      ).toMatchObject({ admitted: true });
    });
  });

  describe('verifyEmail', () => {
    it('re-mints past the email gate and no further: the account MFA requirement still holds a newly-verified user', async () => {
      const account = await insertAccount(db);
      await db
        .update(accountsTable)
        .set({ requireMfaAt: new Date() })
        .where(eq(accountsTable.id, account.id));
      const user = await insertUser(db, {
        accountId: account.id,
        email: `verify-mfa-${randomUUID()}@store.test`,
        password: 'hashed',
      });
      const verification = await insertUserEmailVerification(db, {
        userId: user.id,
      });
      const service = await build();

      const result = await service.verifyEmail(user.id, verification.token);

      expect(await presentAccessToken(result.access_token)).toEqual(HELD);
      expect(
        await presentAccessToken(result.access_token, {
          skipMfaEnrollment: true,
        }),
      ).toMatchObject({ admitted: true });
    });
  });
});

// A "factor" is now either a confirmed TOTP row or a passkey, and they live
// in different tables. These cover the passkey half of password sign-in —
// the TOTP half is the block above, which must keep passing unchanged.
describe('AuthService — factors across TOTP and passkeys (OS-484/OS-489)', () => {
  const password = 'correct-horse-battery-staple';

  async function seedAccountAndUser(opts: { requireMfaAt?: Date | null }) {
    const account = await insertAccount(db);
    if (opts.requireMfaAt !== undefined) {
      await db
        .update(accountsTable)
        .set({ requireMfaAt: opts.requireMfaAt })
        .where(eq(accountsTable.id, account.id));
    }
    const user = await insertUser(db, {
      accountId: account.id,
      email: `factors-${randomUUID()}@store.test`,
      password: await bcrypt.hash(password, 10),
      emailVerifiedAt: new Date(),
    });
    return { account, user };
  }

  describe('signin', () => {
    // Flipped by OS-489: between OS-484 and OS-489 a passkey-only user got
    // straight through, because the challenge step couldn't accept a
    // passkey. Now it can, so a passkey is challenged like any other factor.
    it('challenges a passkey-only user and offers the passkey', async () => {
      const { user } = await seedAccountAndUser({});
      await insertUserPasskey(db, { userId: user.id });
      const service = await build();

      const result = await service.signin({ email: user.email, password });

      if (!result.mfaRequired) throw new Error('expected a challenge');
      expect(result.methods).toEqual(['passkey', 'totp', 'recovery']);
    });

    // The lockout this milestone exists to avoid. A passkey-only user is
    // challenged from OS-489 on; if they can't present the passkey — lost
    // device, different machine, a browser without WebAuthn — the recovery
    // code is their only way in. verifyMfaChallenge used to require a
    // confirmed TOTP row before even looking at the code, which rejected
    // them with "Invalid or expired challenge".
    it('accepts a recovery code from a passkey-only user', async () => {
      const { user } = await seedAccountAndUser({ requireMfaAt: new Date() });
      await insertUserPasskey(db, { userId: user.id });
      const recoveryCode = 'ABCDE-FGHJK';
      await insertUserMfaRecoveryCode(db, {
        userId: user.id,
        codeHash: await bcrypt.hash(recoveryCode, 10),
      });
      const { service, sessions } = await buildBoth();

      const challenge = await service.signin({ email: user.email, password });
      if (!challenge.mfaRequired) throw new Error('expected a challenge');

      const session = await service.verifyMfaChallenge(
        challenge.challengeToken,
        recoveryCode,
      );

      // a full Session, past the enrollment gate: the passkey they hold is
      // what satisfies the account's requirement, even though it isn't what
      // they presented
      expect(await presentAccessToken(session.access_token)).toMatchObject({
        admitted: true,
        user: { sub: user.id },
      });
      await expectWorkingSession(sessions, session, user.id);
    });

    it('does not offer the passkey branch to a TOTP-only user', async () => {
      const { user } = await seedAccountAndUser({});
      await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
      const service = await build();

      const result = await service.signin({ email: user.email, password });

      if (!result.mfaRequired) throw new Error('expected a challenge');
      expect(result.methods).toEqual(['totp', 'recovery']);
    });

    // The other half of the OS-489 flip. A passkey now satisfies an
    // account-wide requirement — but only because the user has to present it
    // at the challenge first, which is what makes it a factor rather than a
    // row in a table.
    it('lets a passkey satisfy account-wide MFA, via the challenge', async () => {
      const { user } = await seedAccountAndUser({ requireMfaAt: new Date() });
      await insertUserPasskey(db, { userId: user.id });
      const service = await build();

      const result = await service.signin({ email: user.email, password });

      // no tokens without presenting it
      expect(result.mfaRequired).toBe(true);
    });

    it('lets a confirmed TOTP factor satisfy account-wide MFA', async () => {
      const { user } = await seedAccountAndUser({ requireMfaAt: new Date() });
      await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
      const service = await build();

      const result = await service.signin({ email: user.email, password });

      // ...by way of the challenge, which is the point: possession is proven
      expect(result.mfaRequired).toBe(true);
    });

    it('still issues a challenge when TOTP is confirmed', async () => {
      const { user } = await seedAccountAndUser({});
      await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
      const service = await build();

      const result = await service.signin({ email: user.email, password });

      expect(result.mfaRequired).toBe(true);
    });
  });
});
