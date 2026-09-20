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
  accountApiKeysTable,
  accountsTable,
  and,
  eq,
  isNotNull,
  permissionsTable,
  rolePermissionsTable,
  rolesTable,
  userEmailVerificationsTable,
  userMfaRecoveryCodesTable,
  userMfaTable,
  userPasskeysTable,
  userPasswordResetsTable,
  userRefreshTokensTable,
  userRolesTable,
  usersTable,
} from 'db/identity';
import { locationsTable } from 'db/stock';
import { type AuthenticatedUser } from 'src/shared/auth/decorators';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { EmailService } from 'src/shared/email/email.service';
import { RolesService } from '../roles/roles.service';
import { UsersService } from '../users/users.service';
import { PermissionsService } from '../permissions/permissions.service';
import { AuthService, claimsFromSignInResult } from './auth.service';

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

// The grace window deliberately lets a just-rotated token be re-presented
// for 10s (a second tab, a retried request) and replay its replacement, so
// a freshly revoked row says nothing useful until that window has passed —
// "the other browser is refused now" passes for the wrong reason inside it.
// Backdating is how the refreshTokens specs get past it without sleeping;
// the live replacement (revokedAt still null) is left alone.
//
// Module-scope so both revocation suites (changePassword, OS-385;
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

async function build() {
  const ref = await Test.createTestingModule({
    providers: [
      AuthService,
      { provide: DRIZZLE, useValue: db },
      {
        provide: JwtService,
        useValue: new JwtService({ secret: 'test-secret' }),
      },
      // real UsersService (needed for requestPasswordReset's getByEmail) —
      // its EmailService/PermissionsService deps are unused on that path
      {
        provide: UsersService,
        useValue: new UsersService(db, {} as never, {} as never),
      },
      // real RolesService for createSystemRole; its PermissionsService dep is
      // unused on that path
      { provide: RolesService, useValue: new RolesService(db, {} as never) },
      // real PermissionsService — signup() doesn't call it, me() does
      { provide: PermissionsService, useValue: new PermissionsService(db) },
      { provide: EmailService, useValue: emailMock },
    ],
  }).compile();
  return ref.get(AuthService);
}

const signupDto = {
  businessName: 'Cactus Coffee',
  firstName: 'Dana',
  lastName: 'Scully',
  email: 'dana@cactus.test',
  phone: '5555550100',
  password: 'supersecret',
};

// Pins the wire format itself, not just the mappers that feed it. The
// claim set is still growing (hasMfaFactor lands next), so these key-set
// assertions are meant to fail loudly when it does — adding a claim should
// be a deliberate edit here, not something that slips through.
describe('AuthService token payloads (OS-482)', () => {
  const decode = (token: string) =>
    new JwtService({ secret: 'test-secret' }).decode<Record<string, unknown>>(
      token,
    );

  const claims = {
    sub: 0, // replaced per-test with a real user id where an FK needs one
    email: signupDto.email,
    accountId: 0,
    firstName: signupDto.firstName,
    lastName: signupDto.lastName,
    emailVerified: false,
    mfaEnrollmentSatisfied: true,
    hasMfaFactor: false,
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
      'hasMfaFactor',
      'iat',
      'lastName',
      'mfaEnrollmentSatisfied',
      'sub',
      'typ',
    ]);
    expect(payload).toMatchObject({ ...claims, typ: 'access' });
  });

  it('signs a refresh token with the same claims plus typ and jti', async () => {
    await db.insert(permissionsTable).values(PERMISSIONS_CATALOG);
    const service = await build();
    const { userId, accountId } = await service.signup(signupDto);
    const payload = decode(
      await service.createRefreshToken(
        { ...claims, sub: userId, accountId },
        randomUUID(),
      ),
    );

    expect(Object.keys(payload).sort()).toEqual([
      'accountId',
      'email',
      'emailVerified',
      'exp',
      'firstName',
      'hasMfaFactor',
      'iat',
      'jti',
      'lastName',
      'mfaEnrollmentSatisfied',
      'sub',
      'typ',
    ]);
    expect(payload).toMatchObject({ typ: 'refresh', sub: userId });
  });
});

describe('AuthService.signup — first-run seed (OS-173)', () => {
  it('seeds the account, api key, Default location, Owner user + role', async () => {
    // permissions are normally upserted at boot by PermissionsService
    await db.insert(permissionsTable).values(PERMISSIONS_CATALOG);
    const service = await build();

    const result = await service.signup(signupDto);
    expect(result.email).toBe(signupDto.email);
    expect(typeof result.accountId).toBe('number');
    expect(typeof result.access_token).toBe('string');

    const [account] = await db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.id, result.accountId));
    expect(account).toMatchObject({ name: 'Cactus Coffee' });

    const apiKeys = await db
      .select()
      .from(accountApiKeysTable)
      .where(eq(accountApiKeysTable.accountId, result.accountId));
    expect(apiKeys).toHaveLength(1);
    expect(apiKeys[0]).toMatchObject({ label: null, revokedAt: null });
    expect(apiKeys[0]?.key).toMatch(/^sfk_/);

    const locations = await db
      .select()
      .from(locationsTable)
      .where(eq(locationsTable.accountId, result.accountId));
    expect(locations).toHaveLength(1);
    expect(locations[0]).toMatchObject({ name: 'Default', addressLine1: null });

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.accountId, result.accountId));
    if (!user) throw new Error('owner user not seeded');
    expect(user.email).toBe(signupDto.email);
    expect(user.password).not.toBe(signupDto.password); // hashed

    const [role] = await db
      .select()
      .from(rolesTable)
      .where(eq(rolesTable.accountId, result.accountId));
    if (!role) throw new Error('Owner role not seeded');
    expect(role).toMatchObject({ name: 'Owner', isSystem: true });

    const userRoles = await db
      .select()
      .from(userRolesTable)
      .where(eq(userRolesTable.userId, user.id));
    expect(userRoles).toEqual([expect.objectContaining({ roleId: role.id })]);

    const rolePerms = await db
      .select()
      .from(rolePermissionsTable)
      .where(eq(rolePermissionsTable.roleId, role.id));
    expect(rolePerms).toHaveLength(PERMISSIONS_CATALOG.length);
  });

  it('leaves the account unverified and sends a verification email (OS-470)', async () => {
    await db.insert(permissionsTable).values(PERMISSIONS_CATALOG);
    const service = await build();

    const result = await service.signup(signupDto);
    expect(result.emailVerified).toBe(false);

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, result.userId));
    expect(user?.emailVerifiedAt).toBeNull();

    const [verification] = await db
      .select()
      .from(userEmailVerificationsTable)
      .where(eq(userEmailVerificationsTable.userId, result.userId));
    expect(verification).toBeDefined();
    expect(emailMock.sendVerificationEmail).toHaveBeenCalledWith(
      signupDto.email,
      expect.objectContaining({ firstName: signupDto.firstName }),
    );
  });

  it('rejects a duplicate email with a ConflictException', async () => {
    const service = await build();
    await service.signup(signupDto);
    await expect(service.signup(signupDto)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('AuthService.me (OS-180)', () => {
  it('returns identity + the caller effective permission keys', async () => {
    await db.insert(permissionsTable).values(PERMISSIONS_CATALOG);
    const service = await build();
    const { userId, accountId } = await service.signup(signupDto);

    const me = await service.me({
      sub: userId,
      email: signupDto.email,
      accountId,
      firstName: signupDto.firstName,
      lastName: signupDto.lastName,
      emailVerified: false,
      mfaEnrollmentSatisfied: true,
      hasMfaFactor: false,
      typ: 'access',
    });

    expect(me).toMatchObject({
      userId,
      accountId,
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

  it('reports totpEnabled: true once a factor is confirmed', async () => {
    await db.insert(permissionsTable).values(PERMISSIONS_CATALOG);
    const service = await build();
    const { userId, accountId } = await service.signup(signupDto);
    await insertUserMfa(db, { userId, confirmedAt: new Date() });

    const me = await service.me({
      sub: userId,
      email: signupDto.email,
      accountId,
      firstName: signupDto.firstName,
      lastName: signupDto.lastName,
      emailVerified: false,
      mfaEnrollmentSatisfied: true,
      hasMfaFactor: false,
      typ: 'access',
    });

    expect(me.totpEnabled).toBe(true);
    expect(me.hasMfaFactor).toBe(true);
    expect(me.passkeyCount).toBe(0);
  });

  it('reports a passkey-only user as hasMfaFactor with totpEnabled false', async () => {
    await db.insert(permissionsTable).values(PERMISSIONS_CATALOG);
    const service = await build();
    const { userId, accountId } = await service.signup(signupDto);
    await insertUserPasskey(db, { userId });
    await insertUserPasskey(db, { userId });

    const me = await service.me({
      sub: userId,
      email: signupDto.email,
      accountId,
      firstName: signupDto.firstName,
      lastName: signupDto.lastName,
      emailVerified: false,
      mfaEnrollmentSatisfied: true,
      hasMfaFactor: false,
      typ: 'access',
    });

    expect(me.totpEnabled).toBe(false);
    expect(me.passkeyCount).toBe(2);
    expect(me.hasMfaFactor).toBe(true);
  });
});

describe('AuthService.refreshTokens (OS-467)', () => {
  async function seedSession() {
    await db.insert(permissionsTable).values(PERMISSIONS_CATALOG);
    const service = await build();
    const { userId, accountId } = await service.signup(signupDto);
    const refreshToken = await service.createRefreshToken(
      {
        sub: userId,
        email: signupDto.email,
        accountId,
        firstName: signupDto.firstName,
        lastName: signupDto.lastName,
        emailVerified: false,
        mfaEnrollmentSatisfied: true,
        hasMfaFactor: false,
      },
      randomUUID(),
    );
    return { service, userId, accountId, refreshToken };
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

  it('rejects an access token presented to the refresh flow (typ mismatch)', async () => {
    const { service, userId, accountId } = await seedSession();
    const accessToken = await service.createAccessToken({
      sub: userId,
      email: signupDto.email,
      accountId,
      firstName: signupDto.firstName,
      lastName: signupDto.lastName,
      emailVerified: false,
      mfaEnrollmentSatisfied: true,
      hasMfaFactor: false,
    });

    await expect(service.refreshTokens(accessToken)).rejects.toThrow(
      'Invalid or expired token',
    );
  });
});

describe('AuthService.logout (OS-467)', () => {
  it('revokes the refresh token family so it can no longer be redeemed', async () => {
    await db.insert(permissionsTable).values(PERMISSIONS_CATALOG);
    const service = await build();
    const { userId, accountId } = await service.signup(signupDto);
    const refreshToken = await service.createRefreshToken(
      {
        sub: userId,
        email: signupDto.email,
        accountId,
        firstName: signupDto.firstName,
        lastName: signupDto.lastName,
        emailVerified: false,
        mfaEnrollmentSatisfied: true,
        hasMfaFactor: false,
      },
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
    await db.insert(userRefreshTokensTable).values([
      { userId: user.id, jti: 'jti-1', familyId: 'family-1' },
      { userId: user.id, jti: 'jti-2', familyId: 'family-2' },
    ]);
    const service = await build();

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

    const tokens = await db
      .select()
      .from(userRefreshTokensTable)
      .where(eq(userRefreshTokensTable.userId, user.id));
    expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);
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

  function claimsFor(user: { id: number; email: string; accountId: number }) {
    return {
      sub: user.id,
      email: user.email,
      accountId: user.accountId,
      firstName: 'Staff',
      lastName: 'Member',
      emailVerified: true,
      mfaEnrollmentSatisfied: true,
      hasMfaFactor: false,
    };
  }

  // what @CurrentUser() hands the controller — the caller's decoded access
  // token, which is what changePassword takes
  function callerOf(user: {
    id: number;
    email: string;
    accountId: number;
  }): AuthenticatedUser {
    return { ...claimsFor(user), typ: 'access' };
  }

  it('replaces the password: the old one stops verifying and the new one starts', async () => {
    const user = await seedUser();
    const service = await build();

    await service.changePassword(
      callerOf(user),
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
    const service = await build();
    const callerToken = await service.createRefreshToken(
      claimsFor(user),
      randomUUID(),
    );

    const result = await service.changePassword(
      callerOf(user),
      CURRENT_PASSWORD,
      NEW_PASSWORD,
      callerToken,
    );

    const rotated = await service.refreshTokens(result.refresh_token);
    expect(typeof rotated.access_token).toBe('string');
  });

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

    await service.changePassword(
      callerOf(user),
      CURRENT_PASSWORD,
      NEW_PASSWORD,
      callerToken,
    );
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

    await service.changePassword(
      callerOf(user),
      CURRENT_PASSWORD,
      NEW_PASSWORD,
      callerToken,
    );

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

  it('revokes every session and starts a fresh one when there is no refresh cookie', async () => {
    const user = await seedUser();
    const service = await build();
    const someToken = await service.createRefreshToken(
      claimsFor(user),
      randomUUID(),
    );

    const result = await service.changePassword(
      callerOf(user),
      CURRENT_PASSWORD,
      NEW_PASSWORD,
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

    await service.changePassword(
      callerOf(user),
      CURRENT_PASSWORD,
      NEW_PASSWORD,
      undefined,
    );

    const rotated = await service.refreshTokens(bystanderToken);
    expect(typeof rotated.access_token).toBe('string');
  });

  it('rejects a wrong current password without touching the row or the sessions', async () => {
    const user = await seedUser();
    const service = await build();
    const callerToken = await service.createRefreshToken(
      claimsFor(user),
      randomUUID(),
    );

    await expect(
      service.changePassword(
        callerOf(user),
        'not-the-current-password',
        NEW_PASSWORD,
        callerToken,
      ),
    ).rejects.toThrow('Current password is incorrect');

    await expect(
      service.verifyPassword(user.id, CURRENT_PASSWORD),
    ).resolves.toBeUndefined();
    const rotated = await service.refreshTokens(callerToken);
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

    await service.changePassword(
      callerOf(user),
      CURRENT_PASSWORD,
      NEW_PASSWORD,
      undefined,
    );

    const [row] = await db
      .select()
      .from(userRefreshTokensTable)
      .where(eq(userRefreshTokensTable.jti, 'already-revoked-jti'));
    expect(row?.revokedAt).toEqual(revokedAt);
  });
});

describe('AuthService.revokeOtherSessions (OS-502)', () => {
  async function seedUser() {
    const account = await insertAccount(db, { name: 'Sign Out Co' });
    return insertUser(db, {
      accountId: account.id,
      password: await bcrypt.hash('correct-horse-battery-staple', 10),
      emailVerifiedAt: new Date(),
    });
  }

  function claimsFor(user: { id: number; email: string; accountId: number }) {
    return {
      sub: user.id,
      email: user.email,
      accountId: user.accountId,
      firstName: 'Staff',
      lastName: 'Member',
      emailVerified: true,
      mfaEnrollmentSatisfied: true,
      hasMfaFactor: false,
    };
  }

  // what @CurrentUser() hands the controller — the caller's decoded access
  // token, which is what revokeOtherSessions takes
  function callerOf(user: {
    id: number;
    email: string;
    accountId: number;
  }): AuthenticatedUser {
    return { ...claimsFor(user), typ: 'access' };
  }

  it('leaves the calling session running — unrotated, and still redeemable', async () => {
    const user = await seedUser();
    const service = await build();
    const callerToken = await service.createRefreshToken(
      claimsFor(user),
      randomUUID(),
    );

    await service.revokeOtherSessions(callerOf(user), callerToken);

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

    await service.revokeOtherSessions(callerOf(user), callerToken);
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

  // OS-503 story 20: the one thing this endpoint must never do is sign out
  // the person who called it. With no usable cookie there's no family to
  // spare, so every family really does go — but the caller is then started
  // on a fresh one, exactly as changePassword's no-cookie path does.
  it('revokes every family when no cookie reaches us, and re-mints the caller', async () => {
    const user = await seedUser();
    const service = await build();
    const someToken = await service.createRefreshToken(
      claimsFor(user),
      randomUUID(),
    );

    const result = await service.revokeOtherSessions(callerOf(user), undefined);
    await elapseGraceWindow(user.id);

    expect(typeof result.access_token).toBe('string');
    // the replacement is a working session, not just a string: redeeming it
    // is what "the caller stayed signed in" actually means
    expect(result.refresh_token).toBeDefined();
    const rotated = await service.refreshTokens(result.refresh_token!);
    expect(typeof rotated.access_token).toBe('string');

    // ...while the pre-existing family, the caller's own included, is dead.
    // Asserted only after the grace window: inside it a freshly revoked row
    // with no successor is refused for the wrong reason.
    await expect(service.refreshTokens(someToken)).rejects.toThrow(
      'Invalid or expired token',
    );
  });

  it('hands back a fresh access token without a cookie to write when the caller is spared', async () => {
    const user = await seedUser();
    const service = await build();
    const callerToken = await service.createRefreshToken(
      claimsFor(user),
      randomUUID(),
    );

    const result = await service.revokeOtherSessions(
      callerOf(user),
      callerToken,
    );

    expect(typeof result.access_token).toBe('string');
    // no rotation happened, so there is nothing for the controller to set —
    // the cookie the browser already holds is still the live one
    expect(result.refresh_token).toBeUndefined();
  });

  it('spares nothing when the cookie that reaches us is already stale', async () => {
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

    await service.revokeOtherSessions(callerOf(user), staleToken);
    await elapseGraceWindow(user.id);

    // The stale row names a live family, so sparing on it would leave that
    // family's current token alive — and since a stale cookie is exactly
    // what a browser someone else is holding might present, that would keep
    // alive the session this call exists to end. Liveness, not just
    // ownership, is what decides whether there's a family to spare.
    await expect(service.refreshTokens(currentToken)).rejects.toThrow(
      'Invalid or expired token',
    );
  });

  it("leaves another user's sessions alone", async () => {
    const user = await seedUser();
    const bystander = await seedUser();
    const service = await build();
    const bystanderToken = await service.createRefreshToken(
      claimsFor(bystander),
      randomUUID(),
    );

    await service.revokeOtherSessions(callerOf(user), undefined);

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

    await service.revokeOtherSessions(callerOf(user), undefined);

    const [row] = await db
      .select()
      .from(userRefreshTokensTable)
      .where(eq(userRefreshTokensTable.jti, 'already-revoked-jti'));
    expect(row?.revokedAt).toEqual(revokedAt);
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
    const service = await build();

    const result = await service.acceptInvite({
      token: invite.token,
      password: 'brand-new-password',
    });

    expect(result.emailVerified).toBe(true);

    const [updated] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, user.id));
    expect(updated?.emailVerifiedAt).not.toBeNull();
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

  it('verifies the caller and re-mints their access token with the updated claim', async () => {
    const user = await seedUnverifiedUser();
    const verification = await insertUserEmailVerification(db, {
      userId: user.id,
    });
    expect(typeof verification.id).toBe('number');
    expect(verification.userId).toBe(user.id);
    expect(verification.expiresAt).toBeInstanceOf(Date);
    const service = await build();

    const result = await service.verifyEmail(user.id, verification.token);
    expect(
      new JwtService({ secret: 'test-secret' }).decode<{
        emailVerified: boolean;
      }>(result.access_token)?.emailVerified,
    ).toBe(true);

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
    it('signs in normally when no MFA is enrolled', async () => {
      const user = await seedUserWithPassword();
      const service = await build();

      const result = await service.signin({ email: user.email, password });

      expect(result.mfaRequired).toBe(false);
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
  });

  describe('verifyMfaChallenge', () => {
    it('completes a full enroll → challenge → verify round trip with a TOTP code', async () => {
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

      const result = await service.verifyMfaChallenge(
        signInResult.challengeToken,
        await freshTotpCode(secret),
      );

      expect(result.access_token).toBeTruthy();
      expect(result.userId).toBe(user.id);
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

    it('rejects a real access token presented as a challenge token', async () => {
      const user = await seedUserWithPassword();
      const service = await build();
      const accessToken = await service.createAccessToken({
        sub: user.id,
        email: user.email,
        accountId: user.accountId,
        firstName: user.firstname,
        lastName: user.lastname,
        emailVerified: true,
        mfaEnrollmentSatisfied: true,
        hasMfaFactor: false,
      });

      await expect(
        service.verifyMfaChallenge(accessToken, '123456'),
      ).rejects.toThrow('Invalid or expired challenge');
    });
  });

  describe('disableMfa', () => {
    it('requires the current password', async () => {
      const user = await seedUserWithPassword();
      await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
      const service = await build();

      await expect(
        service.disableMfa(user.id, 'wrong-password'),
      ).rejects.toThrow();
    });

    it('removes the MFA row and every recovery code on success', async () => {
      const user = await seedUserWithPassword();
      await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
      await insertUserMfaRecoveryCode(db, { userId: user.id });
      const service = await build();

      await service.disableMfa(user.id, password);

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

      await expect(service.disableMfa(user.id, password)).rejects.toThrow(
        'Your account requires MFA',
      );

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

      await expect(service.disableMfa(user.id, password)).rejects.toThrow(
        ConflictException,
      );

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

      await service.disableMfa(user.id, password);

      const mfaRows = await db
        .select()
        .from(userMfaTable)
        .where(eq(userMfaTable.userId, user.id));
      expect(mfaRows).toHaveLength(0);
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

describe('AuthService — account-wide MFA enforcement (OS-473)', () => {
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
      email: `mfa-enforce-${randomUUID()}@store.test`,
      password: await bcrypt.hash(password, 10),
      emailVerifiedAt: new Date(),
    });
    return { account, user };
  }

  describe('signin', () => {
    it('is satisfied when the account does not require MFA', async () => {
      const { user } = await seedAccountAndUser({});
      const service = await build();

      const result = await service.signin({ email: user.email, password });

      if (result.mfaRequired) throw new Error('expected a normal sign-in');
      expect(result.mfaEnrollmentSatisfied).toBe(true);
    });

    it('is unsatisfied when the account requires MFA and the user has not enrolled', async () => {
      const { user } = await seedAccountAndUser({ requireMfaAt: new Date() });
      const service = await build();

      const result = await service.signin({ email: user.email, password });

      if (result.mfaRequired) throw new Error('expected a normal sign-in');
      expect(result.mfaEnrollmentSatisfied).toBe(false);
      // still signs in — this is a post-login gate, not a hard block
      expect(result.access_token).toBeTruthy();
    });

    it('still issues a challenge (unaffected by the account toggle) once the user has a confirmed factor', async () => {
      const { user } = await seedAccountAndUser({ requireMfaAt: new Date() });
      await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
      const service = await build();

      const result = await service.signin({ email: user.email, password });

      expect(result.mfaRequired).toBe(true);
    });
  });

  describe('verifyMfaChallenge', () => {
    it('is satisfied after completing the challenge, even when the account requires MFA', async () => {
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

      const result = await service.verifyMfaChallenge(
        signInResult.challengeToken,
        await freshTotpCode(secret),
      );

      expect(result.mfaEnrollmentSatisfied).toBe(true);
    });
  });

  describe('acceptInvite', () => {
    it('is unsatisfied when the account already requires MFA at invite-accept time', async () => {
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

      const result = await service.acceptInvite({
        token: invite.token,
        password: 'brand-new-password',
      });

      expect(result.mfaEnrollmentSatisfied).toBe(false);
    });

    // Was "is satisfied when the account does not require MFA" until OS-494:
    // joining staff are now gated on their own, whatever the account policy.
    it('stamps factor_required_at and is unsatisfied even when the account does not require MFA (OS-494)', async () => {
      const account = await insertAccount(db);
      const user = await insertUser(db, {
        accountId: account.id,
        password: null,
      });
      const invite = await insertUserInvite(db, { userId: user.id });
      const service = await build();

      const result = await service.acceptInvite({
        token: invite.token,
        password: 'brand-new-password',
      });

      expect(result.mfaEnrollmentSatisfied).toBe(false);
      expect(result.hasMfaFactor).toBe(false);
      const payload = new JwtService({
        secret: 'test-secret',
      }).decode<{ mfaEnrollmentSatisfied: boolean }>(result.access_token);
      expect(payload.mfaEnrollmentSatisfied).toBe(false);

      const [row] = await db
        .select({ factorRequiredAt: usersTable.factorRequiredAt })
        .from(usersTable)
        .where(eq(usersTable.id, user.id));
      expect(row.factorRequiredAt).toBeInstanceOf(Date);
    });
  });

  describe('invited-staff factor requirement (OS-494)', () => {
    async function seedJoinedStaff() {
      const account = await insertAccount(db);
      const user = await insertUser(db, {
        accountId: account.id,
        email: `joined-staff-${randomUUID()}@store.test`,
        password: await bcrypt.hash(password, 10),
        emailVerifiedAt: new Date(),
        factorRequiredAt: new Date(),
      });
      return { account, user };
    }

    async function refreshedClaims(
      service: AuthService,
      user: { email: string },
    ) {
      const signInResult = await service.signin({
        email: user.email,
        password,
      });
      if (signInResult.mfaRequired)
        throw new Error('expected a normal sign-in');
      const refreshToken = await service.createRefreshToken(
        claimsFromSignInResult(signInResult),
        randomUUID(),
      );
      return { signInResult, refreshToken };
    }

    it('signin is unsatisfied for a joined staff member with no factor', async () => {
      const { user } = await seedJoinedStaff();
      const service = await build();

      const result = await service.signin({ email: user.email, password });

      if (result.mfaRequired) throw new Error('expected a normal sign-in');
      expect(result.mfaEnrollmentSatisfied).toBe(false);
    });

    // The whole reason the column exists: merchant-web refreshes on every
    // navigation, and refreshTokens recomputes this claim from the database.
    // An unsatisfied claim that wasn't backed by stored state flipped to
    // true here, one click after joining.
    it('stays unsatisfied across a token refresh', async () => {
      const { user } = await seedJoinedStaff();
      const service = await build();
      const { refreshToken } = await refreshedClaims(service, user);

      const refreshed = await service.refreshTokens(refreshToken);
      const payload = new JwtService({
        secret: 'test-secret',
      }).decode<{ mfaEnrollmentSatisfied: boolean }>(refreshed.access_token);

      expect(payload.mfaEnrollmentSatisfied).toBe(false);
    });

    it.each([
      [
        'an authenticator',
        (userId: number) =>
          insertUserMfa(db, { userId, confirmedAt: new Date() }),
      ],
      ['a passkey', (userId: number) => insertUserPasskey(db, { userId })],
    ])(
      'is satisfied on refresh once %s is enrolled',
      async (_label, enroll) => {
        const { user } = await seedJoinedStaff();
        const service = await build();
        const { refreshToken } = await refreshedClaims(service, user);

        await enroll(user.id);

        const refreshed = await service.refreshTokens(refreshToken);
        const payload = new JwtService({
          secret: 'test-secret',
        }).decode<{ mfaEnrollmentSatisfied: boolean }>(refreshed.access_token);

        expect(payload.mfaEnrollmentSatisfied).toBe(true);
      },
    );

    // Owners explore freely and are gated at the money actions instead
    // (OS-492) — signup must never stamp the column, and a refresh must not
    // start gating them either.
    it('leaves an owner who signs up ungated, across a refresh too', async () => {
      await db.insert(permissionsTable).values(PERMISSIONS_CATALOG);
      const service = await build();

      const result = await service.signup(signupDto);

      expect(result.mfaEnrollmentSatisfied).toBe(true);
      const [row] = await db
        .select({ factorRequiredAt: usersTable.factorRequiredAt })
        .from(usersTable)
        .where(eq(usersTable.id, result.userId));
      expect(row.factorRequiredAt).toBeNull();

      const refreshToken = await service.createRefreshToken(
        claimsFromSignInResult(result),
        randomUUID(),
      );
      const refreshed = await service.refreshTokens(refreshToken);
      const payload = new JwtService({
        secret: 'test-secret',
      }).decode<{ mfaEnrollmentSatisfied: boolean }>(refreshed.access_token);
      expect(payload.mfaEnrollmentSatisfied).toBe(true);
    });
  });

  describe('verifyEmail', () => {
    it('reflects the account MFA requirement for a newly-verified user', async () => {
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

      expect(
        new JwtService({ secret: 'test-secret' }).decode<{
          mfaEnrollmentSatisfied: boolean;
        }>(result.access_token)?.mfaEnrollmentSatisfied,
      ).toBe(false);
    });
  });

  describe('refreshTokens', () => {
    it('picks up the account toggle turning on mid-session', async () => {
      const { account, user } = await seedAccountAndUser({});
      const service = await build();
      const signInResult = await service.signin({
        email: user.email,
        password,
      });
      if (signInResult.mfaRequired)
        throw new Error('expected a normal sign-in');
      const refreshToken = await service.createRefreshToken(
        claimsFromSignInResult(signInResult),
        randomUUID(),
      );

      // owner turns the requirement on after this session already started
      await db
        .update(accountsTable)
        .set({ requireMfaAt: new Date() })
        .where(eq(accountsTable.id, account.id));

      const refreshed = await service.refreshTokens(refreshToken);
      const payload = new JwtService({
        secret: 'test-secret',
      }).decode<{ mfaEnrollmentSatisfied: boolean }>(refreshed.access_token);

      expect(payload.mfaEnrollmentSatisfied).toBe(false);
    });

    it('picks up enrollment completing mid-session', async () => {
      const { user } = await seedAccountAndUser({
        requireMfaAt: new Date(),
      });
      const service = await build();
      const signInResult = await service.signin({
        email: user.email,
        password,
      });
      if (signInResult.mfaRequired)
        throw new Error('expected a normal sign-in');
      expect(signInResult.mfaEnrollmentSatisfied).toBe(false);
      const refreshToken = await service.createRefreshToken(
        claimsFromSignInResult(signInResult),
        randomUUID(),
      );

      // user finishes forced enrollment mid-session
      await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });

      const refreshed = await service.refreshTokens(refreshToken);
      const payload = new JwtService({
        secret: 'test-secret',
      }).decode<{ mfaEnrollmentSatisfied: boolean }>(refreshed.access_token);

      expect(payload.mfaEnrollmentSatisfied).toBe(true);
    });
  });
});

// A "factor" is now either a confirmed TOTP row or a passkey, and they live
// in different tables. These cover the passkey half — the TOTP half is the
// OS-473 block above, which must keep passing unchanged.
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
      const { user } = await seedAccountAndUser({});
      await insertUserPasskey(db, { userId: user.id });
      const recoveryCode = 'ABCDE-FGHJK';
      await insertUserMfaRecoveryCode(db, {
        userId: user.id,
        codeHash: await bcrypt.hash(recoveryCode, 10),
      });
      const service = await build();

      const challenge = await service.signin({ email: user.email, password });
      if (!challenge.mfaRequired) throw new Error('expected a challenge');

      const result = await service.verifyMfaChallenge(
        challenge.challengeToken,
        recoveryCode,
      );

      expect(result.access_token).toBeTruthy();
      expect(result.hasMfaFactor).toBe(true);
    });

    it('does not offer the passkey branch to a TOTP-only user', async () => {
      const { user } = await seedAccountAndUser({});
      await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
      const service = await build();

      const result = await service.signin({ email: user.email, password });

      if (!result.mfaRequired) throw new Error('expected a challenge');
      expect(result.methods).toEqual(['totp', 'recovery']);
    });

    // The whole point of the claim split: this user is blocked by nothing,
    // but also holds nothing, so a gated action must still stop them.
    it('leaves hasMfaFactor false for a user with no factor at all', async () => {
      const { user } = await seedAccountAndUser({});
      const service = await build();

      const result = await service.signin({ email: user.email, password });

      if (result.mfaRequired) throw new Error('expected a normal sign-in');
      expect(result.mfaEnrollmentSatisfied).toBe(true);
      expect(result.hasMfaFactor).toBe(false);
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

  describe('refreshTokens', () => {
    it('picks up a passkey registered mid-session', async () => {
      const { user } = await seedAccountAndUser({ requireMfaAt: new Date() });
      const service = await build();
      const signInResult = await service.signin({
        email: user.email,
        password,
      });
      if (signInResult.mfaRequired)
        throw new Error('expected a normal sign-in');
      expect(signInResult.hasMfaFactor).toBe(false);
      expect(signInResult.mfaEnrollmentSatisfied).toBe(false);

      const refreshToken = await service.createRefreshToken(
        claimsFromSignInResult(signInResult),
        randomUUID(),
      );

      await insertUserPasskey(db, { userId: user.id });

      const refreshed = await service.refreshTokens(refreshToken);
      const payload = new JwtService({ secret: 'test-secret' }).decode<{
        hasMfaFactor: boolean;
        mfaEnrollmentSatisfied: boolean;
      }>(refreshed.access_token);

      expect(payload.hasMfaFactor).toBe(true);
      // and since OS-489 that also clears the account-wide requirement,
      // without waiting for a re-login
      expect(payload.mfaEnrollmentSatisfied).toBe(true);
    });

    it('drops hasMfaFactor when the last passkey is removed mid-session', async () => {
      const { user } = await seedAccountAndUser({});
      const service = await build();
      // sign in BEFORE the passkey exists — a user holding one is now
      // challenged, and this test is about the claim, not the challenge
      const signInResult = await service.signin({
        email: user.email,
        password,
      });
      if (signInResult.mfaRequired)
        throw new Error('expected a normal sign-in');
      const passkey = await insertUserPasskey(db, { userId: user.id });

      const refreshToken = await service.createRefreshToken(
        claimsFromSignInResult(signInResult),
        randomUUID(),
      );

      const jwt = new JwtService({ secret: 'test-secret' });

      // the claim first has to become true, or "drops" proves nothing
      const withPasskey = await service.refreshTokens(refreshToken);
      expect(
        jwt.decode<{ hasMfaFactor: boolean }>(withPasskey.access_token)
          .hasMfaFactor,
      ).toBe(true);

      await db
        .delete(userPasskeysTable)
        .where(eq(userPasskeysTable.id, passkey.id));

      const afterRemoval = await service.refreshTokens(
        withPasskey.refresh_token,
      );
      expect(
        jwt.decode<{ hasMfaFactor: boolean }>(afterRemoval.access_token)
          .hasMfaFactor,
      ).toBe(false);
    });
  });
});
