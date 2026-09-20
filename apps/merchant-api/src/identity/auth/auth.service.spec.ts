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
  accountsTable,
  eq,
  permissionsTable,
  userEmailVerificationsTable,
  userMfaRecoveryCodesTable,
  userMfaTable,
  userPasskeysTable,
  userPasswordResetsTable,
  userRefreshTokensTable,
  usersTable,
} from 'db/identity';
import { type AuthenticatedUser } from 'src/shared/auth/decorators';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { EmailService } from 'src/shared/email/email.service';
import { AccountService } from '../account/account.service';
import { RolesService } from '../roles/roles.service';
import { UsersService } from '../users/users.service';
import { PermissionsService } from '../permissions/permissions.service';
import { AuthService, claimsFromSignInResult } from './auth.service';
import { FactorStateService } from './factor-state.service';
import { SessionsService } from './sessions.service';

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

// Both halves of a sign-in: AuthService proves who the caller is, and
// SessionsService mints and rotates what they're handed afterwards. Specs
// that only exercise the first half use build().
async function buildBoth() {
  const ref = await Test.createTestingModule({
    providers: [
      AuthService,
      SessionsService,
      FactorStateService,
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
  };
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
  it('provisions the account and returns a token for its first Owner', async () => {
    await db.insert(permissionsTable).values(PERMISSIONS_CATALOG);
    const service = await build();

    const result = await service.signup(signupDto);
    expect(result.email).toBe(signupDto.email);
    expect(typeof result.accountId).toBe('number');
    expect(typeof result.access_token).toBe('string');

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, result.userId));
    expect(user).toMatchObject({
      email: signupDto.email,
      accountId: result.accountId,
    });
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
      typ: 'access',
    });

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
    const { service, sessions } = await buildBoth();
    const callerToken = await sessions.createRefreshToken(
      claimsFor(user),
      randomUUID(),
    );

    const result = await service.changePassword(
      callerOf(user),
      CURRENT_PASSWORD,
      NEW_PASSWORD,
      callerToken,
    );

    const rotated = await sessions.refreshTokens(result.refresh_token);
    expect(typeof rotated.access_token).toBe('string');
  });

  it('rejects a wrong current password without touching the row or the sessions', async () => {
    const user = await seedUser();
    const { service, sessions } = await buildBoth();
    const callerToken = await sessions.createRefreshToken(
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
    const rotated = await sessions.refreshTokens(callerToken);
    expect(typeof rotated.access_token).toBe('string');
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
      const { service, sessions } = await buildBoth();
      const accessToken = await sessions.createAccessToken({
        sub: user.id,
        email: user.email,
        accountId: user.accountId,
        firstName: user.firstname,
        lastName: user.lastname,
        emailVerified: true,
        mfaEnrollmentSatisfied: true,
      });

      await expect(
        service.verifyMfaChallenge(accessToken, '123456'),
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
      { service, sessions }: Awaited<ReturnType<typeof buildBoth>>,
      user: { email: string },
    ) {
      const signInResult = await service.signin({
        email: user.email,
        password,
      });
      if (signInResult.mfaRequired)
        throw new Error('expected a normal sign-in');
      const refreshToken = await sessions.createRefreshToken(
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
      const built = await buildBoth();
      const { sessions } = built;
      const { refreshToken } = await refreshedClaims(built, user);

      const refreshed = await sessions.refreshTokens(refreshToken);
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
        const built = await buildBoth();
        const { sessions } = built;
        const { refreshToken } = await refreshedClaims(built, user);

        await enroll(user.id);

        const refreshed = await sessions.refreshTokens(refreshToken);
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
      const { service, sessions } = await buildBoth();

      const result = await service.signup(signupDto);

      expect(result.mfaEnrollmentSatisfied).toBe(true);
      const [row] = await db
        .select({ factorRequiredAt: usersTable.factorRequiredAt })
        .from(usersTable)
        .where(eq(usersTable.id, result.userId));
      expect(row.factorRequiredAt).toBeNull();

      const refreshToken = await sessions.createRefreshToken(
        claimsFromSignInResult(result),
        randomUUID(),
      );
      const refreshed = await sessions.refreshTokens(refreshToken);
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
      const { service, sessions } = await buildBoth();
      const signInResult = await service.signin({
        email: user.email,
        password,
      });
      if (signInResult.mfaRequired)
        throw new Error('expected a normal sign-in');
      const refreshToken = await sessions.createRefreshToken(
        claimsFromSignInResult(signInResult),
        randomUUID(),
      );

      // owner turns the requirement on after this session already started
      await db
        .update(accountsTable)
        .set({ requireMfaAt: new Date() })
        .where(eq(accountsTable.id, account.id));

      const refreshed = await sessions.refreshTokens(refreshToken);
      const payload = new JwtService({
        secret: 'test-secret',
      }).decode<{ mfaEnrollmentSatisfied: boolean }>(refreshed.access_token);

      expect(payload.mfaEnrollmentSatisfied).toBe(false);
    });

    it('picks up enrollment completing mid-session', async () => {
      const { user } = await seedAccountAndUser({
        requireMfaAt: new Date(),
      });
      const { service, sessions } = await buildBoth();
      const signInResult = await service.signin({
        email: user.email,
        password,
      });
      if (signInResult.mfaRequired)
        throw new Error('expected a normal sign-in');
      expect(signInResult.mfaEnrollmentSatisfied).toBe(false);
      const refreshToken = await sessions.createRefreshToken(
        claimsFromSignInResult(signInResult),
        randomUUID(),
      );

      // user finishes forced enrollment mid-session
      await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });

      const refreshed = await sessions.refreshTokens(refreshToken);
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

  describe('refreshTokens', () => {
    it('picks up a passkey registered mid-session', async () => {
      const { user } = await seedAccountAndUser({ requireMfaAt: new Date() });
      const { service, sessions } = await buildBoth();
      const signInResult = await service.signin({
        email: user.email,
        password,
      });
      if (signInResult.mfaRequired)
        throw new Error('expected a normal sign-in');
      expect(signInResult.mfaEnrollmentSatisfied).toBe(false);

      const refreshToken = await sessions.createRefreshToken(
        claimsFromSignInResult(signInResult),
        randomUUID(),
      );

      await insertUserPasskey(db, { userId: user.id });

      const refreshed = await sessions.refreshTokens(refreshToken);
      const payload = new JwtService({ secret: 'test-secret' }).decode<{
        mfaEnrollmentSatisfied: boolean;
      }>(refreshed.access_token);

      // since OS-489 a passkey clears the account-wide requirement, without
      // waiting for a re-login
      expect(payload.mfaEnrollmentSatisfied).toBe(true);
    });

    it('stops being satisfied when the last passkey is removed mid-session', async () => {
      const { user } = await seedAccountAndUser({ requireMfaAt: new Date() });
      const { service, sessions } = await buildBoth();
      // sign in BEFORE the passkey exists — a user holding one is now
      // challenged, and this test is about the claim, not the challenge
      const signInResult = await service.signin({
        email: user.email,
        password,
      });
      if (signInResult.mfaRequired)
        throw new Error('expected a normal sign-in');
      const passkey = await insertUserPasskey(db, { userId: user.id });

      const refreshToken = await sessions.createRefreshToken(
        claimsFromSignInResult(signInResult),
        randomUUID(),
      );

      const jwt = new JwtService({ secret: 'test-secret' });

      // the claim first has to become true, or "drops" proves nothing
      const withPasskey = await sessions.refreshTokens(refreshToken);
      expect(
        jwt.decode<{ mfaEnrollmentSatisfied: boolean }>(
          withPasskey.access_token,
        ).mfaEnrollmentSatisfied,
      ).toBe(true);

      await db
        .delete(userPasskeysTable)
        .where(eq(userPasskeysTable.id, passkey.id));

      const afterRemoval = await sessions.refreshTokens(
        withPasskey.refresh_token,
      );
      expect(
        jwt.decode<{ mfaEnrollmentSatisfied: boolean }>(
          afterRemoval.access_token,
        ).mfaEnrollmentSatisfied,
      ).toBe(false);
    });
  });
});
