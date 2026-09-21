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
  eq,
  userMfaRecoveryCodesTable,
  userPasskeysTable,
  userRefreshTokensTable,
  usersTable,
  webauthnChallengesTable,
} from 'db/identity';
import {
  deactivateUser,
  insertAccountWithUser,
  liveRefreshTokenCount,
  insertUserMfa,
  insertUserPasskey,
  insertWebauthnChallenge,
  useTestDb,
} from 'test-support';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { EmailService } from 'src/shared/email/email.service';
import { AccountService } from '../account/account.service';
import { UsersService } from '../users/users.service';
import { PermissionsService } from '../permissions/permissions.service';
import { AuthService } from './auth.service';
import { EmailedLinksService } from '../emailed-links/emailed-links.service';
import { FactorStateService } from './factor-state.service';
import { SessionsService } from './sessions.service';
import { PasskeysService } from './passkeys.service';
import { isoBase64URL, isoUint8Array } from '@simplewebauthn/server/helpers';
import {
  TEST_JWT_SECRET,
  expectWorkingSession,
  presentAccessToken,
} from './sessions.spec-support';

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
  verifyAuthenticationResponse: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const webauthn = require('@simplewebauthn/server') as {
  verifyRegistrationResponse: jest.Mock;
  verifyAuthenticationResponse: jest.Mock;
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

function assertionVerifies(newCounter = 1) {
  webauthn.verifyAuthenticationResponse.mockResolvedValue({
    verified: true,
    authenticationInfo: { newCounter },
  });
}

beforeEach(() => {
  webauthn.verifyRegistrationResponse.mockReset();
  webauthn.verifyAuthenticationResponse.mockReset();
});

async function buildRef() {
  return Test.createTestingModule({
    providers: [
      AuthService,
      SessionsService,
      FactorStateService,
      PasskeysService,
      // AuthService's Emailed links collaborator — no passkey path reaches it
      EmailedLinksService,
      { provide: DRIZZLE, useValue: db },
      {
        provide: JwtService,
        useValue: new JwtService({ secret: TEST_JWT_SECRET }),
      },
      {
        provide: UsersService,
        useValue: new UsersService(db, {} as never, {} as never, {} as never),
      },
      // signup()'s collaborator — no passkey path reaches it
      { provide: AccountService, useValue: {} },
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
}

async function build() {
  return (await buildRef()).get(PasskeysService);
}

// every User here can sign in with `password` — removal and registration
// re-verify it
async function seedUser(
  opts: Omit<Parameters<typeof insertAccountWithUser>[1], 'password'> = {},
) {
  return insertAccountWithUser(db, {
    ...opts,
    password: await bcrypt.hash(password, 10),
  });
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

  it('stores the credential and re-mints an access token the enrollment gate now accepts', async () => {
    // a staff member at the join gate (OS-494): the token they registered
    // with is held there, and the one they get back must not be
    const { user } = await seedUser({ factorRequiredAt: new Date() });
    const ref = await buildRef();
    const service = ref.get(PasskeysService);
    const session = await ref.get(SessionsService).start(user.id);
    expect(await presentAccessToken(session.access_token)).toEqual({
      admitted: false,
      refusal: 'MFA enrollment required',
    });
    const challenge = await optionsChallengeFor(service, user.id);
    verifierReturns('new-credential');

    const result = await service.verifyRegistration(
      user.id,
      responseFor(challenge) as never,
      'MacBook',
    );

    expect(result.passkey).toMatchObject({
      nickname: 'MacBook',
      backedUp: true,
    });
    // the same as confirmMfa — leaving them with the stale claim would keep
    // them gated until the next refresh. Safe since OS-489: sign-in
    // challenges on a passkey, so holding one really is enrollment.
    expect(await presentAccessToken(result.access_token)).toMatchObject({
      admitted: true,
      user: { sub: user.id },
    });
    // a re-mint, not a new Session
    expect(await db.select().from(userRefreshTokensTable)).toHaveLength(1);
  });

  // Adding a Factor only strengthens sign-in, so nobody is signed out for it
  // — the opposite of remove() (see "the Sessions it ends" below).
  it("leaves the User's other Sessions alive (OS-554)", async () => {
    const { user } = await seedUser();
    const ref = await buildRef();
    const service = ref.get(PasskeysService);
    const sessions = ref.get(SessionsService);
    const otherBrowser = await sessions.start(user.id);
    const challenge = await optionsChallengeFor(service, user.id);
    verifierReturns('new-credential');

    await service.verifyRegistration(
      user.id,
      responseFor(challenge) as never,
      undefined,
    );

    await expectWorkingSession(sessions, otherBrowser, user.id);
  });

  it('never returns the credential id or public key', async () => {
    const { user } = await seedUser();
    const service = await build();
    const challenge = await optionsChallengeFor(service, user.id);
    verifierReturns('secret-credential-id');

    const result = await service.verifyRegistration(
      user.id,
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
        user.id,
        responseFor(challenge) as never,
        undefined,
      );

      verifierReturns('second');
      await expect(
        service.verifyRegistration(
          user.id,
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
          user.id,
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
          user.id,
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
          mine.id,
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
        user.id,
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
        user.id,
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
      user.id,
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

  // Counting after the insert commits would let two concurrent first
  // registrations each see two credentials and each conclude they weren't
  // first — leaving the user with two passkeys and no recovery codes at all.
  it('issues exactly one batch across two concurrent first registrations', async () => {
    const { user } = await seedUser();
    const service = await build();
    const challengeA = await optionsChallengeFor(service, user.id);
    const challengeB = await optionsChallengeFor(service, user.id);

    // each ceremony returns its own credential id
    let call = 0;
    webauthn.verifyRegistrationResponse.mockImplementation(() => {
      call += 1;
      return Promise.resolve({
        verified: true,
        registrationInfo: {
          credential: {
            id: `concurrent-${call}`,
            publicKey: new Uint8Array([1, 2, 3, 4]),
            counter: 0,
            transports: ['internal'],
          },
          credentialDeviceType: 'multiDevice',
          credentialBackedUp: true,
          aaguid: '00000000-0000-0000-0000-000000000000',
        },
      });
    });

    const results = await Promise.allSettled([
      service.verifyRegistration(
        user.id,
        responseFor(challengeA) as never,
        undefined,
      ),
      service.verifyRegistration(
        user.id,
        responseFor(challengeB) as never,
        undefined,
      ),
    ]);

    const issued = results.filter(
      (r) => r.status === 'fulfilled' && r.value.recoveryCodes,
    );
    expect(issued).toHaveLength(1);

    const stored = await db
      .select()
      .from(userMfaRecoveryCodesTable)
      .where(eq(userMfaRecoveryCodesTable.userId, user.id));
    expect(stored).toHaveLength(10);
  });

  // The test above only catches the race when the two transactions actually
  // interleave, which isn't guaranteed. This asserts the mechanism directly:
  // registration must do its counting behind the shared factor lock, or the
  // "first factor" decision is a read of state another request can change.
  it('counts factors behind the shared lock', async () => {
    const { user } = await seedUser();
    const ref = await buildRef();
    const service = ref.get(PasskeysService);
    const lockSpy = jest.spyOn(ref.get(AuthService), 'lockUserFactors');
    const challenge = await optionsChallengeFor(service, user.id);
    verifierReturns('locked');

    await service.verifyRegistration(
      user.id,
      responseFor(challenge) as never,
      undefined,
    );

    expect(lockSpy).toHaveBeenCalledWith(expect.anything(), user.id);
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

    await service.remove(user.id, passkey.id, password, undefined);

    expect(await db.select().from(userPasskeysTable)).toHaveLength(0);
  });

  it('refuses removal on a wrong password', async () => {
    const { user } = await seedUser();
    const passkey = await insertUserPasskey(db, { userId: user.id });
    const service = await build();

    await expect(
      service.remove(user.id, passkey.id, 'wrong', undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await db.select().from(userPasskeysTable)).toHaveLength(1);
  });

  it("refuses to remove another user's credential", async () => {
    const { user } = await seedUser();
    const { user: other } = await seedUser();
    const theirs = await insertUserPasskey(db, { userId: other.id });
    const service = await build();

    await expect(
      service.remove(user.id, theirs.id, password, undefined),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('last-factor rule', () => {
    it('refuses to remove the last factor when the account requires MFA', async () => {
      const { user } = await seedUser({ accountRequiresMfa: true });
      const passkey = await insertUserPasskey(db, { userId: user.id });
      const service = await build();

      await expect(
        service.remove(user.id, passkey.id, password, undefined),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    // the invited-staff stamp (OS-494) holds the last factor in place on its
    // own, with no account-wide policy set
    it('refuses to remove the last factor when factor_required_at is set', async () => {
      const { user } = await seedUser({ factorRequiredAt: new Date() });
      const passkey = await insertUserPasskey(db, { userId: user.id });
      const service = await build();

      await expect(
        service.remove(user.id, passkey.id, password, undefined),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('allows removing one of two', async () => {
      const { user } = await seedUser({ accountRequiresMfa: true });
      const first = await insertUserPasskey(db, { userId: user.id });
      await insertUserPasskey(db, { userId: user.id });
      const service = await build();

      await service.remove(user.id, first.id, password, undefined);

      expect(await db.select().from(userPasskeysTable)).toHaveLength(1);
    });

    it('allows removing the last passkey when TOTP remains', async () => {
      const { user } = await seedUser({ accountRequiresMfa: true });
      const passkey = await insertUserPasskey(db, { userId: user.id });
      await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
      const service = await build();

      await service.remove(user.id, passkey.id, password, undefined);

      expect(await db.select().from(userPasskeysTable)).toHaveLength(0);
    });

    // The rule is a check followed by a delete, so without a lock two
    // concurrent removals each see two factors, each conclude one will
    // remain, and the user lands on zero on an account that requires MFA.
    // Same shape as the concurrent recovery-code redemption test.
    it('lets only one of two concurrent removals through', async () => {
      const { user } = await seedUser({ accountRequiresMfa: true });
      const first = await insertUserPasskey(db, { userId: user.id });
      const second = await insertUserPasskey(db, { userId: user.id });
      const service = await build();

      const results = await Promise.allSettled([
        service.remove(user.id, first.id, password, undefined),
        service.remove(user.id, second.id, password, undefined),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      // the invariant that actually matters: never zero factors
      expect(await db.select().from(userPasskeysTable)).toHaveLength(1);
    });

    // no requirement to satisfy — the user is free to hold nothing
    it('allows removing the last factor when the account does not require MFA', async () => {
      const { user } = await seedUser();
      const passkey = await insertUserPasskey(db, { userId: user.id });
      const service = await build();

      await service.remove(user.id, passkey.id, password, undefined);

      expect(await db.select().from(userPasskeysTable)).toHaveLength(0);
    });
  });

  // Removing a Factor is a credential change, the same kind of event as
  // changing the password — if someone else added that passkey, their Session
  // must not outlive it. The sweep itself is
  // SessionsService.revokeOthersAndRotate's suite (sessions.service.spec);
  // these pin that remove() reaches it, and when.
  describe('the Sessions it ends (OS-554)', () => {
    async function buildWithSessions() {
      const ref = await buildRef();
      return {
        service: ref.get(PasskeysService),
        sessions: ref.get(SessionsService),
      };
    }

    it("ends the User's other Sessions and rotates the caller's", async () => {
      const { user } = await seedUser();
      const passkey = await insertUserPasskey(db, { userId: user.id });
      const { service, sessions } = await buildWithSessions();
      const caller = await sessions.start(user.id);
      const otherBrowser = await sessions.start(user.id);

      const replacement = await service.remove(
        user.id,
        passkey.id,
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
      const { user } = await seedUser();
      const passkey = await insertUserPasskey(db, { userId: user.id });
      const { service, sessions } = await buildWithSessions();
      const someBrowser = await sessions.start(user.id);

      const fresh = await service.remove(
        user.id,
        passkey.id,
        password,
        undefined,
      );

      await expect(
        sessions.refreshTokens(someBrowser.refresh_token),
      ).rejects.toThrow('Invalid or expired token');
      expect(await liveRefreshTokenCount(db, user.id)).toBe(1);
      await expectWorkingSession(sessions, fresh, user.id);
    });

    // Order matters: a refused removal changed no credential, so it must not
    // cost anyone their Session either.
    it('touches no Session when the last-Factor rule refuses', async () => {
      const { user } = await seedUser({ accountRequiresMfa: true });
      const passkey = await insertUserPasskey(db, { userId: user.id });
      const { service, sessions } = await buildWithSessions();
      const caller = await sessions.start(user.id);
      const otherBrowser = await sessions.start(user.id);

      await expect(
        service.remove(user.id, passkey.id, password, caller.refresh_token),
      ).rejects.toBeInstanceOf(ConflictException);

      await expectWorkingSession(sessions, caller, user.id);
      await expectWorkingSession(sessions, otherBrowser, user.id);
    });

    it("touches no Session on a wrong password or someone else's passkey", async () => {
      const { user } = await seedUser();
      const { user: other } = await seedUser();
      const mine = await insertUserPasskey(db, { userId: user.id });
      const theirs = await insertUserPasskey(db, { userId: other.id });
      const { service, sessions } = await buildWithSessions();
      const caller = await sessions.start(user.id);
      const otherBrowser = await sessions.start(user.id);

      await expect(
        service.remove(user.id, mine.id, 'wrong', caller.refresh_token),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(
        service.remove(user.id, theirs.id, password, caller.refresh_token),
      ).rejects.toBeInstanceOf(NotFoundException);

      await expectWorkingSession(sessions, caller, user.id);
      await expectWorkingSession(sessions, otherBrowser, user.id);
    });
  });

  it('cascades credentials when the user is deleted', async () => {
    const { user } = await seedUser();
    await insertUserPasskey(db, { userId: user.id });

    await db.delete(usersTable).where(eq(usersTable.id, user.id));

    expect(await db.select().from(userPasskeysTable)).toHaveLength(0);
  });
});

describe('PasskeysService — challenge assertion (OS-488)', () => {
  // the passkey branch of the password-then-second-factor step: the caller
  // holds a signin()-issued challenge token and no session
  // The token comes from a real signin() rather than being minted by hand,
  // so the test exercises the actual issuance path. That needs a confirmed
  // TOTP factor as well, because until OS-489 signin only challenges on
  // TOTP — which is also the realistic shape here: someone who holds both
  // and is offered the passkey first.
  async function seedChallengedUser(opts: Parameters<typeof seedUser>[0] = {}) {
    const { user } = await seedUser(opts);
    await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
    const passkey = await insertUserPasskey(db, {
      userId: user.id,
      credentialId: 'challenge-cred',
      publicKey: isoBase64URL.fromBuffer(new Uint8Array([9, 9, 9, 9])),
      counter: 0,
    });
    const ref = await buildRef();
    const service = ref.get(PasskeysService);
    const authService = ref.get(AuthService);

    const signin = await authService.signin({ email: user.email, password });
    if (!signin.mfaRequired) throw new Error('expected an MFA challenge');
    // signin advertises the passkey branch to the client
    expect(signin.methods).toContain('passkey');

    return {
      user,
      passkey,
      service,
      sessionsService: ref.get(SessionsService),
      token: signin.challengeToken,
    };
  }

  function assertionFor(challenge: string, credentialId = 'challenge-cred') {
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge,
        origin: 'http://localhost:5000',
      }),
    ).toString('base64url');
    return {
      id: credentialId,
      rawId: credentialId,
      type: 'public-key',
      response: { clientDataJSON },
    };
  }

  it('scopes the options to the challenged user credentials', async () => {
    const { user, service, token } = await seedChallengedUser();

    const options = await service.getChallengeAuthenticationOptions(token);

    expect(options.userVerification).toBe('required');
    expect(options.allowCredentials).toEqual([
      expect.objectContaining({ id: 'challenge-cred' }),
    ]);
    const [row] = await db
      .select()
      .from(webauthnChallengesTable)
      .where(eq(webauthnChallengesTable.challenge, options.challenge));
    expect(row).toMatchObject({ type: 'authentication', userId: user.id });
  });

  it('exchanges a valid assertion for a Session and stamps the credential', async () => {
    const { user, passkey, service, sessionsService, token } =
      await seedChallengedUser({ accountRequiresMfa: true });
    const options = await service.getChallengeAuthenticationOptions(token);
    assertionVerifies(7);

    const session = await service.verifyChallengeAssertion(
      token,
      assertionFor(options.challenge) as never,
    );

    // past every gate, the account-wide requirement included: the Factor
    // they just proved is what satisfies it
    expect(await presentAccessToken(session.access_token)).toMatchObject({
      admitted: true,
      user: { sub: user.id },
    });
    await expectWorkingSession(sessionsService, session, user.id);

    const [stored] = await db
      .select()
      .from(userPasskeysTable)
      .where(eq(userPasskeysTable.id, passkey.id));
    expect(stored?.counter).toBe(7);
    expect(stored?.lastUsedAt).not.toBeNull();
  });

  // The credential lookup is by credentialId, which is unique globally —
  // without the ownership check, anyone's passkey satisfies anyone's
  // challenge, which is the entire second factor.
  it("rejects another user's credential", async () => {
    const { service, token } = await seedChallengedUser();
    const { user: attacker } = await seedUser();
    await insertUserPasskey(db, {
      userId: attacker.id,
      credentialId: 'attacker-cred',
    });
    const options = await service.getChallengeAuthenticationOptions(token);
    assertionVerifies();

    await expect(
      service.verifyChallengeAssertion(
        token,
        assertionFor(options.challenge, 'attacker-cred') as never,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an access token presented as a challenge token', async () => {
    const { user, service, sessionsService } = await seedChallengedUser();
    const { access_token } = await sessionsService.start(user.id);

    await expect(
      service.getChallengeAuthenticationOptions(access_token),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a replayed challenge', async () => {
    const { service, token } = await seedChallengedUser();
    const options = await service.getChallengeAuthenticationOptions(token);
    assertionVerifies();
    await service.verifyChallengeAssertion(
      token,
      assertionFor(options.challenge) as never,
    );

    await expect(
      service.verifyChallengeAssertion(
        token,
        assertionFor(options.challenge) as never,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // The usernameless door checks deactivation itself; this one inherits it
  // from the shared challenge-token resolution. Deactivated AFTER the options
  // were issued, so it's the completion being refused — the step that would
  // otherwise hand over a Session (OS-504).
  it('refuses a Session to a User deactivated mid-challenge', async () => {
    const { user, passkey, service, token } = await seedChallengedUser();
    const options = await service.getChallengeAuthenticationOptions(token);
    assertionVerifies(7);

    await deactivateUser(db, user.id);

    const attempt = service.verifyChallengeAssertion(
      token,
      assertionFor(options.challenge) as never,
    );
    await expect(attempt).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(attempt).rejects.toThrow('Invalid or expired challenge');

    const [stored] = await db
      .select()
      .from(userPasskeysTable)
      .where(eq(userPasskeysTable.id, passkey.id));
    expect(stored?.lastUsedAt).toBeNull();
    expect(await db.select().from(userRefreshTokensTable)).toHaveLength(0);
  });

  // a registration challenge must not be redeemable as an assertion
  it('rejects a challenge issued for registration', async () => {
    const { user, service, token } = await seedChallengedUser();
    const registration = await insertWebauthnChallenge(db, {
      type: 'registration',
      userId: user.id,
    });
    assertionVerifies();

    await expect(
      service.verifyChallengeAssertion(
        token,
        assertionFor(registration.challenge) as never,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // a counter going backwards means two authenticators hold the same
  // credential — one of them is a clone
  it('rejects a regressed signature counter', async () => {
    const { passkey, service, token } = await seedChallengedUser();
    await db
      .update(userPasskeysTable)
      .set({ counter: 10 })
      .where(eq(userPasskeysTable.id, passkey.id));
    const options = await service.getChallengeAuthenticationOptions(token);
    assertionVerifies(5);

    await expect(
      service.verifyChallengeAssertion(
        token,
        assertionFor(options.challenge) as never,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // The exemption for counter-less authenticators must not apply when the
  // STORED counter is positive: that's a 10 -> 0 regression, and the update
  // would persist the 0 and disarm clone detection from then on. The
  // verifier is mocked here, so this only passes if our own check is right.
  it('rejects an assertion reporting zero against a positive stored counter', async () => {
    const { passkey, service, token } = await seedChallengedUser();
    await db
      .update(userPasskeysTable)
      .set({ counter: 10 })
      .where(eq(userPasskeysTable.id, passkey.id));
    const options = await service.getChallengeAuthenticationOptions(token);
    assertionVerifies(0);

    await expect(
      service.verifyChallengeAssertion(
        token,
        assertionFor(options.challenge) as never,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const [stored] = await db
      .select()
      .from(userPasskeysTable)
      .where(eq(userPasskeysTable.id, passkey.id));
    expect(stored?.counter).toBe(10);
  });

  // most platform authenticators don't implement counters and always
  // report 0 — that must not look like a clone
  it('accepts a counter that stays at zero', async () => {
    const { service, token } = await seedChallengedUser();
    const options = await service.getChallengeAuthenticationOptions(token);
    assertionVerifies(0);

    const result = await service.verifyChallengeAssertion(
      token,
      assertionFor(options.challenge) as never,
    );

    expect(result.access_token).toBeTruthy();
  });

  it('refuses options for a user holding no passkey', async () => {
    const { user } = await seedUser();
    await insertUserMfa(db, { userId: user.id, confirmedAt: new Date() });
    const ref = await buildRef();
    const signin = await ref
      .get(AuthService)
      .signin({ email: user.email, password });
    if (!signin.mfaRequired) throw new Error('expected an MFA challenge');
    // and doesn't advertise a branch the user can't complete
    expect(signin.methods).not.toContain('passkey');

    await expect(
      ref
        .get(PasskeysService)
        .getChallengeAuthenticationOptions(signin.challengeToken),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('PasskeysService — usernameless sign-in (OS-490)', () => {
  async function seedCredential(
    opts: { deactivated?: boolean; accountRequiresMfa?: boolean } = {},
  ) {
    const { user } = await seedUser({
      accountRequiresMfa: opts.accountRequiresMfa,
    });
    if (opts.deactivated) {
      await deactivateUser(db, user.id);
    }
    const passkey = await insertUserPasskey(db, {
      userId: user.id,
      credentialId: 'discoverable-cred',
      publicKey: isoBase64URL.fromBuffer(new Uint8Array([4, 4, 4, 4])),
      counter: 0,
    });
    const [row] = await db
      .select({ handle: usersTable.webauthnHandle })
      .from(usersTable)
      .where(eq(usersTable.id, user.id));
    const ref = await buildRef();
    return {
      user,
      passkey,
      service: ref.get(PasskeysService),
      sessionsService: ref.get(SessionsService),
      handle: row.handle,
    };
  }

  // A real browser returns userHandle BASE64URL-ENCODED — registration hands
  // the authenticator raw bytes and @simplewebauthn/browser serializes them
  // back with bufferToBase64URLString. Encoding it here rather than passing
  // the raw string is the whole point: the first version of these specs sent
  // the raw handle, which agreed with the bug in the code and let a sign-in
  // path that rejected every real authenticator pass its tests.
  function assertionFor(
    challenge: string,
    opts: { credentialId?: string; userHandle?: string | null } = {},
  ) {
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge,
        origin: 'http://localhost:5000',
      }),
    ).toString('base64url');
    const credentialId = opts.credentialId ?? 'discoverable-cred';
    return {
      id: credentialId,
      rawId: credentialId,
      type: 'public-key',
      response: {
        clientDataJSON,
        ...(opts.userHandle === null || opts.userHandle === undefined
          ? {}
          : {
              userHandle: isoBase64URL.fromBuffer(
                isoUint8Array.fromUTF8String(opts.userHandle),
              ),
            }),
      },
    };
  }

  // an EMPTY allowCredentials is what makes the credential discoverable —
  // the authenticator picks one rather than us naming candidates
  it('issues unscoped options and a challenge with no user', async () => {
    const { service } = await seedCredential();

    const options = await service.getSignInOptions();

    expect(options.allowCredentials ?? []).toHaveLength(0);
    expect(options.userVerification).toBe('required');
    const [row] = await db
      .select()
      .from(webauthnChallengesTable)
      .where(eq(webauthnChallengesTable.challenge, options.challenge));
    expect(row).toMatchObject({ type: 'authentication', userId: null });
  });

  it('resolves the user from the credential alone and signs them in', async () => {
    const { user, passkey, service, sessionsService, handle } =
      await seedCredential({ accountRequiresMfa: true });
    const options = await service.getSignInOptions();
    assertionVerifies(3);

    const session = await service.verifySignIn(
      assertionFor(options.challenge, { userHandle: handle }) as never,
    );

    // A Session like any other sign-in's, for the User the credential names
    // — and past the account's MFA requirement: a user-verified assertion is
    // possession + biometric in one gesture.
    expect(await presentAccessToken(session.access_token)).toMatchObject({
      admitted: true,
      user: { sub: user.id, accountId: user.accountId },
    });
    await expectWorkingSession(sessionsService, session, user.id);

    const [stored] = await db
      .select()
      .from(userPasskeysTable)
      .where(eq(userPasskeysTable.id, passkey.id));
    expect(stored?.counter).toBe(3);
    expect(stored?.lastUsedAt).not.toBeNull();
  });

  it('rejects an unknown credential', async () => {
    const { service } = await seedCredential();
    const options = await service.getSignInOptions();
    assertionVerifies();

    await expect(
      service.verifySignIn(
        assertionFor(options.challenge, {
          credentialId: 'never-seen',
        }) as never,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // password sign-in filters these out via UsersService.getByEmail; this
  // path doesn't go through it, and the credential still sits on the
  // ex-staff member's device
  it('rejects a deactivated user', async () => {
    const { service, handle } = await seedCredential({ deactivated: true });
    const options = await service.getSignInOptions();
    assertionVerifies();

    await expect(
      service.verifySignIn(
        assertionFor(options.challenge, { userHandle: handle }) as never,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a userHandle that disagrees with the stored one', async () => {
    const { service } = await seedCredential();
    const options = await service.getSignInOptions();
    assertionVerifies();

    await expect(
      service.verifySignIn(
        assertionFor(options.challenge, {
          userHandle: 'someone-elses-handle',
        }) as never,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a replayed challenge', async () => {
    const { service, handle } = await seedCredential();
    const options = await service.getSignInOptions();
    assertionVerifies();
    await service.verifySignIn(
      assertionFor(options.challenge, { userHandle: handle }) as never,
    );

    await expect(
      service.verifySignIn(
        assertionFor(options.challenge, { userHandle: handle }) as never,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a regressed counter here too', async () => {
    const { passkey, service, handle } = await seedCredential();
    await db
      .update(userPasskeysTable)
      .set({ counter: 10 })
      .where(eq(userPasskeysTable.id, passkey.id));
    const options = await service.getSignInOptions();
    assertionVerifies(2);

    await expect(
      service.verifySignIn(
        assertionFor(options.challenge, { userHandle: handle }) as never,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // a scoped challenge belongs to one user's second-factor step; it must
  // not double as an anonymous sign-in
  it('rejects a challenge that was scoped to a user', async () => {
    const { user, service, handle } = await seedCredential();
    const scoped = await insertWebauthnChallenge(db, {
      type: 'authentication',
      userId: user.id,
    });
    assertionVerifies();

    await expect(
      service.verifySignIn(
        assertionFor(scoped.challenge, { userHandle: handle }) as never,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
