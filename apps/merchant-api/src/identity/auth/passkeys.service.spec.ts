import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import {
  accountsTable,
  eq,
  userMfaRecoveryCodesTable,
  userPasskeysTable,
  usersTable,
  webauthnChallengesTable,
} from 'db/identity';
import {
  insertAccount,
  insertUser,
  insertUserMfa,
  insertUserPasskey,
  insertWebauthnChallenge,
  useTestDb,
} from 'test-support';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { EmailService } from 'src/shared/email/email.service';
import { RolesService } from '../roles/roles.service';
import { UsersService } from '../users/users.service';
import { PermissionsService } from '../permissions/permissions.service';
import { AuthService } from './auth.service';
import { PasskeysService } from './passkeys.service';
import { type AuthenticatedUser } from 'src/shared/auth/decorators';

// The WebAuthn verifier itself is mocked. Its COSE/CBOR parsing and
// signature checks are @simplewebauthn's code, already tested upstream, and
// synthesizing a real attestation object in Node is a multi-day detour that
// would be testing someone else's library.
//
// What IS ours, and what these specs cover: challenge single-use and expiry,
// type confusion between ceremonies, ownership scoping, duplicate
// credentials, when recovery codes get issued, and the last-factor rule.
jest.mock('@simplewebauthn/server', () => ({
  ...jest.requireActual<Record<string, unknown>>('@simplewebauthn/server'),
  verifyRegistrationResponse: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const webauthn = require('@simplewebauthn/server') as {
  verifyRegistrationResponse: jest.Mock;
};

const db = useTestDb();
const password = 'correct-horse-battery-staple';

function verifierReturns(credentialId: string) {
  webauthn.verifyRegistrationResponse.mockResolvedValue({
    verified: true,
    registrationInfo: {
      credential: {
        id: credentialId,
        publicKey: new Uint8Array([1, 2, 3, 4]),
        counter: 0,
        transports: ['internal'],
      },
      credentialDeviceType: 'multiDevice',
      credentialBackedUp: true,
      aaguid: '00000000-0000-0000-0000-000000000000',
    },
  });
}

beforeEach(() => {
  webauthn.verifyRegistrationResponse.mockReset();
});

async function build() {
  const ref = await Test.createTestingModule({
    providers: [
      AuthService,
      PasskeysService,
      { provide: DRIZZLE, useValue: db },
      {
        provide: JwtService,
        useValue: new JwtService({ secret: 'test-secret' }),
      },
      {
        provide: UsersService,
        useValue: new UsersService(db, {} as never, {} as never),
      },
      { provide: RolesService, useValue: new RolesService(db, {} as never) },
      { provide: PermissionsService, useValue: new PermissionsService(db) },
      {
        provide: EmailService,
        useValue: {
          sendInviteEmail: jest.fn(),
          sendVerificationEmail: jest.fn(),
        },
      },
    ],
  }).compile();
  return ref.get(PasskeysService);
}

async function seedUser(
  opts: { requireMfaAt?: Date; emailVerified?: boolean } = {},
) {
  const account = await insertAccount(db);
  if (opts.requireMfaAt) {
    await db
      .update(accountsTable)
      .set({ requireMfaAt: opts.requireMfaAt })
      .where(eq(accountsTable.id, account.id));
  }
  const user = await insertUser(db, {
    accountId: account.id,
    password: await bcrypt.hash(password, 10),
    emailVerifiedAt: opts.emailVerified === false ? null : new Date(),
  });
  return { account, user };
}

function principal(user: {
  id: number;
  accountId: number;
  email: string;
}): AuthenticatedUser {
  return {
    sub: user.id,
    email: user.email,
    accountId: user.accountId,
    firstName: 'Staff',
    lastName: 'Member',
    emailVerified: true,
    mfaEnrollmentSatisfied: true,
    hasMfaFactor: false,
    typ: 'access',
  };
}

// A RegistrationResponseJSON is only ever handed to the mocked verifier, so
// all that matters here is that clientDataJSON carries the challenge the way
// a real browser response does — that's what the service reads to find which
// challenge to consume.
function responseFor(challenge: string) {
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: 'webauthn.create',
      challenge,
      origin: 'http://localhost:5000',
    }),
  ).toString('base64url');
  return {
    id: 'ignored',
    rawId: 'ignored',
    type: 'public-key',
    response: { clientDataJSON },
  };
}

async function optionsChallengeFor(service: PasskeysService, userId: number) {
  const options = await service.getRegistrationOptions(userId);
  return options.challenge;
}

describe('PasskeysService — registration (OS-485)', () => {
  it('issues options and persists a single-use challenge', async () => {
    const { user } = await seedUser();
    const service = await build();

    const options = await service.getRegistrationOptions(user.id);

    expect(options.rp.id).toBe('localhost');
    expect(options.authenticatorSelection?.userVerification).toBe('required');
    expect(options.authenticatorSelection?.residentKey).toBe('required');

    const [row] = await db
      .select()
      .from(webauthnChallengesTable)
      .where(eq(webauthnChallengesTable.challenge, options.challenge));
    expect(row).toMatchObject({
      type: 'registration',
      userId: user.id,
      consumedAt: null,
    });
  });

  it('refuses before the email is verified', async () => {
    const { user } = await seedUser({ emailVerified: false });
    const service = await build();

    await expect(
      service.getRegistrationOptions(user.id),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('excludes credentials the user already holds', async () => {
    const { user } = await seedUser();
    await insertUserPasskey(db, {
      userId: user.id,
      credentialId: 'already-here',
    });
    const service = await build();

    const options = await service.getRegistrationOptions(user.id);

    expect(options.excludeCredentials).toEqual([
      expect.objectContaining({ id: 'already-here' }),
    ]);
  });

  it('stores the credential and re-mints with hasMfaFactor', async () => {
    const { user } = await seedUser();
    const service = await build();
    const challenge = await optionsChallengeFor(service, user.id);
    verifierReturns('new-credential');

    const result = await service.verifyRegistration(
      principal(user),
      responseFor(challenge) as never,
      'MacBook',
    );

    expect(result.passkey).toMatchObject({
      nickname: 'MacBook',
      backedUp: true,
    });
    const payload = new JwtService({ secret: 'test-secret' }).decode<{
      hasMfaFactor: boolean;
      mfaEnrollmentSatisfied: boolean;
    }>(result.access_token);
    expect(payload.hasMfaFactor).toBe(true);
    // deliberately carried over, NOT forced true — a passkey doesn't satisfy
    // an account-wide requirement until sign-in can challenge on it (OS-489)
    expect(payload.mfaEnrollmentSatisfied).toBe(true);
  });

  it('never returns the credential id or public key', async () => {
    const { user } = await seedUser();
    const service = await build();
    const challenge = await optionsChallengeFor(service, user.id);
    verifierReturns('secret-credential-id');

    const result = await service.verifyRegistration(
      principal(user),
      responseFor(challenge) as never,
      undefined,
    );

    expect(JSON.stringify(result.passkey)).not.toContain(
      'secret-credential-id',
    );
    expect(result.passkey).not.toHaveProperty('publicKey');
  });

  describe('challenge handling', () => {
    it('rejects a challenge that was already spent', async () => {
      const { user } = await seedUser();
      const service = await build();
      const challenge = await optionsChallengeFor(service, user.id);
      verifierReturns('first');
      await service.verifyRegistration(
        principal(user),
        responseFor(challenge) as never,
        undefined,
      );

      verifierReturns('second');
      await expect(
        service.verifyRegistration(
          principal(user),
          responseFor(challenge) as never,
          undefined,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects an expired challenge', async () => {
      const { user } = await seedUser();
      const service = await build();
      const stale = await insertWebauthnChallenge(db, {
        type: 'registration',
        userId: user.id,
        expiresAt: new Date(Date.now() - 1000),
      });
      verifierReturns('whatever');

      await expect(
        service.verifyRegistration(
          principal(user),
          responseFor(stale.challenge) as never,
          undefined,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    // an authentication challenge must not be redeemable as a registration
    it('rejects a challenge issued for the other ceremony', async () => {
      const { user } = await seedUser();
      const service = await build();
      const other = await insertWebauthnChallenge(db, {
        type: 'authentication',
        userId: user.id,
      });
      verifierReturns('whatever');

      await expect(
        service.verifyRegistration(
          principal(user),
          responseFor(other.challenge) as never,
          undefined,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    // the challenge is globally unique, so without the userId scope one
    // user could spend another's pending registration
    it("rejects another user's challenge", async () => {
      const { user: mine } = await seedUser();
      const { user: theirs } = await seedUser();
      const service = await build();
      const theirChallenge = await optionsChallengeFor(service, theirs.id);
      verifierReturns('whatever');

      await expect(
        service.verifyRegistration(
          principal(mine),
          responseFor(theirChallenge) as never,
          undefined,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('prunes expired challenges when issuing a new one', async () => {
      const { user } = await seedUser();
      await insertWebauthnChallenge(db, {
        type: 'registration',
        userId: user.id,
        expiresAt: new Date(Date.now() - 1000),
      });
      const service = await build();

      await service.getRegistrationOptions(user.id);

      const rows = await db.select().from(webauthnChallengesTable);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  it('rejects a credential id already registered anywhere', async () => {
    const { user: other } = await seedUser();
    await insertUserPasskey(db, { userId: other.id, credentialId: 'taken' });
    const { user } = await seedUser();
    const service = await build();
    const challenge = await optionsChallengeFor(service, user.id);
    verifierReturns('taken');

    await expect(
      service.verifyRegistration(
        principal(user),
        responseFor(challenge) as never,
        undefined,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a response the verifier does not accept', async () => {
    const { user } = await seedUser();
    const service = await build();
    const challenge = await optionsChallengeFor(service, user.id);
    webauthn.verifyRegistrationResponse.mockResolvedValue({ verified: false });

    await expect(
      service.verifyRegistration(
        principal(user),
        responseFor(challenge) as never,
        undefined,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('PasskeysService — recovery codes (OS-485)', () => {
  async function register(
    service: PasskeysService,
    user: { id: number; accountId: number; email: string },
    credentialId: string,
  ) {
    const challenge = await optionsChallengeFor(service, user.id);
    verifierReturns(credentialId);
    return service.verifyRegistration(
      principal(user),
      responseFor(challenge) as never,
      undefined,
    );
  }

  // Before passkeys this was only reachable from confirmMfa, which would
  // have left a passkey-only user with no recovery path at all.
  it('issues one batch on the first factor', async () => {
    const { user } = await seedUser();
    const service = await build();

    const result = await register(service, user, 'first');

    expect(result.recoveryCodes).toHaveLength(10);
    const stored = await db
      .select()
      .from(userMfaRecoveryCodesTable)
      .where(eq(userMfaRecoveryCodesTable.userId, user.id));
    expect(stored).toHaveLength(10);
  });

  it('does not re-issue on a second passkey', async () => {
    const { user } = await seedUser();
    const service = await build();
    await register(service, user, 'first');

    const second = await register(service, user, 'second');

    expect(second.recoveryCodes).toBeUndefined();
  });

  // this user already got their batch from confirmMfa
  it('does not issue when TOTP is already confirmed', async () => {
    const { user } = await seedUser();
    await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
    const service = await build();

    const result = await register(service, user, 'alongside-totp');

    expect(result.recoveryCodes).toBeUndefined();
  });
});

describe('PasskeysService — management (OS-485)', () => {
  it("renames only the caller's own credential", async () => {
    const { user } = await seedUser();
    const { user: other } = await seedUser();
    const theirs = await insertUserPasskey(db, { userId: other.id });
    const service = await build();

    await expect(
      service.rename(user.id, theirs.id, 'Mine now'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('removes a credential after a password check', async () => {
    const { user } = await seedUser();
    const passkey = await insertUserPasskey(db, { userId: user.id });
    const service = await build();

    await service.remove(user.id, user.accountId, passkey.id, password);

    expect(await db.select().from(userPasskeysTable)).toHaveLength(0);
  });

  it('refuses removal on a wrong password', async () => {
    const { user } = await seedUser();
    const passkey = await insertUserPasskey(db, { userId: user.id });
    const service = await build();

    await expect(
      service.remove(user.id, user.accountId, passkey.id, 'wrong'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await db.select().from(userPasskeysTable)).toHaveLength(1);
  });

  it("refuses to remove another user's credential", async () => {
    const { user } = await seedUser();
    const { user: other } = await seedUser();
    const theirs = await insertUserPasskey(db, { userId: other.id });
    const service = await build();

    await expect(
      service.remove(user.id, user.accountId, theirs.id, password),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('last-factor rule', () => {
    it('refuses to remove the last factor when the account requires MFA', async () => {
      const { user } = await seedUser({ requireMfaAt: new Date() });
      const passkey = await insertUserPasskey(db, { userId: user.id });
      const service = await build();

      await expect(
        service.remove(user.id, user.accountId, passkey.id, password),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('allows removing one of two', async () => {
      const { user } = await seedUser({ requireMfaAt: new Date() });
      const first = await insertUserPasskey(db, { userId: user.id });
      await insertUserPasskey(db, { userId: user.id });
      const service = await build();

      await service.remove(user.id, user.accountId, first.id, password);

      expect(await db.select().from(userPasskeysTable)).toHaveLength(1);
    });

    it('allows removing the last passkey when TOTP remains', async () => {
      const { user } = await seedUser({ requireMfaAt: new Date() });
      const passkey = await insertUserPasskey(db, { userId: user.id });
      await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
      const service = await build();

      await service.remove(user.id, user.accountId, passkey.id, password);

      expect(await db.select().from(userPasskeysTable)).toHaveLength(0);
    });

    // no requirement to satisfy — the user is free to hold nothing
    it('allows removing the last factor when the account does not require MFA', async () => {
      const { user } = await seedUser();
      const passkey = await insertUserPasskey(db, { userId: user.id });
      const service = await build();

      await service.remove(user.id, user.accountId, passkey.id, password);

      expect(await db.select().from(userPasskeysTable)).toHaveLength(0);
    });
  });

  it('cascades credentials when the user is deleted', async () => {
    const { user } = await seedUser();
    await insertUserPasskey(db, { userId: user.id });

    await db.delete(usersTable).where(eq(usersTable.id, user.id));

    expect(await db.select().from(userPasskeysTable)).toHaveLength(0);
  });
});
