import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConflictException } from '@nestjs/common';
import {
  useTestDb,
  insertAccount,
  insertUser,
  insertUserPasswordReset,
  insertUserEmailVerification,
  insertUserInvite,
} from 'test-support';
import {
  PERMISSIONS_CATALOG,
  accountApiKeysTable,
  accountsTable,
  eq,
  permissionsTable,
  rolePermissionsTable,
  rolesTable,
  userEmailVerificationsTable,
  userPasswordResetsTable,
  userRefreshTokensTable,
  userRolesTable,
  usersTable,
} from 'db/identity';
import { locationsTable } from 'db/stock';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { EmailService } from 'src/shared/email/email.service';
import { RolesService } from '../roles/roles.service';
import { UsersService } from '../users/users.service';
import { PermissionsService } from '../permissions/permissions.service';
import { AuthService } from './auth.service';

const db = useTestDb();

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
      typ: 'access',
    });

    expect(me).toMatchObject({
      userId,
      accountId,
      email: signupDto.email,
      firstName: signupDto.firstName,
      lastName: signupDto.lastName,
      emailVerified: false,
    });
    // fresh signup → Owner role → every catalog key, sorted
    expect(me.permissions).toEqual(
      [...PERMISSIONS_CATALOG.map((p) => p.key)].sort(),
    );
  });
});

describe('AuthService.refreshTokens (OS-467)', () => {
  async function seedSession() {
    await db.insert(permissionsTable).values(PERMISSIONS_CATALOG);
    const service = await build();
    const { userId, accountId } = await service.signup(signupDto);
    const refreshToken = await service.createRefreshToken(
      userId,
      signupDto.email,
      accountId,
      signupDto.firstName,
      signupDto.lastName,
      false,
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
    // simulates a device that verified elsewhere and never got the fresh
    // pair verify-email mints, so a rotation is the next chance to notice
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

    expect(second).toEqual(first);
  });

  it('rejects an access token presented to the refresh flow (typ mismatch)', async () => {
    const { service, userId, accountId } = await seedSession();
    const accessToken = await service.createAccessToken(
      userId,
      signupDto.email,
      accountId,
      signupDto.firstName,
      signupDto.lastName,
      false,
    );

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
      userId,
      signupDto.email,
      accountId,
      signupDto.firstName,
      signupDto.lastName,
      false,
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
      .where(eq(userPasswordResetsTable.token, reset.token));
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

  it('verifies the account and returns a token pair with the updated claim', async () => {
    const user = await seedUnverifiedUser();
    const verification = await insertUserEmailVerification(db, {
      userId: user.id,
    });
    const service = await build();

    const result = await service.verifyEmail(verification.token);
    expect(result.emailVerified).toBe(true);

    const [updated] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, user.id));
    expect(updated?.emailVerifiedAt).not.toBeNull();

    const remaining = await db
      .select()
      .from(userEmailVerificationsTable)
      .where(eq(userEmailVerificationsTable.token, verification.token));
    expect(remaining).toHaveLength(0);
  });

  it('rejects an expired token', async () => {
    const user = await seedUnverifiedUser();
    const verification = await insertUserEmailVerification(db, {
      userId: user.id,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const service = await build();

    await expect(service.verifyEmail(verification.token)).rejects.toThrow(
      'Invalid or expired token',
    );
  });

  it('rejects an unknown token', async () => {
    const service = await build();
    await expect(service.verifyEmail('not-a-real-token')).rejects.toThrow(
      'Invalid or expired token',
    );
  });

  it('rejects a token that has already been used', async () => {
    const user = await seedUnverifiedUser();
    const verification = await insertUserEmailVerification(db, {
      userId: user.id,
    });
    const service = await build();

    await service.verifyEmail(verification.token);

    await expect(service.verifyEmail(verification.token)).rejects.toThrow(
      'Invalid or expired token',
    );
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
