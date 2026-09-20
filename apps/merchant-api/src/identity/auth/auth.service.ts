import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { authenticator } from 'otplib';
import { SignInDto } from './dto/signin.dto';
import { SignUpDto } from './dto/signup.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { UsersService } from '../users/users.service';
import { AccountService } from '../account/account.service';
import { PermissionsService } from '../permissions/permissions.service';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { type AuthenticatedUser } from 'src/shared/auth/decorators';
import { type FactorState, FactorStateService } from './factor-state.service';
import { SessionsService, type TokenPair } from './sessions.service';
import { AuthMe } from './entities/auth-me.entity';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { EmailService } from 'src/shared/email/email.service';
import { env } from 'src/shared/env';
import {
  generateToken,
  hashToken,
} from 'src/shared/common/generate-token.util';
import { decryptMfaSecret, encryptMfaSecret } from 'src/shared/mfa/mfa-crypto';
import { generateRecoveryCodes } from 'src/shared/mfa/recovery-codes.util';
import {
  and,
  type db as Db,
  eq,
  isNull,
  isUniqueViolation,
  userEmailVerificationsTable,
  userMfaRecoveryCodesTable,
  userMfaTable,
  userPasswordResetsTable,
  usersTable,
} from 'db/identity';
import * as bcrypt from 'bcryptjs';

// deliberately much shorter than the 7-day invite TTL — an existing active
// user can always request a fresh link, so there's no cost to expiring fast
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

// no urgency signal the way a password reset has ("someone might be taking
// over your account right now") — a generous window is fine
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

// long enough to type a code in, short enough that a challenge token isn't
// worth much if it leaks (e.g. via a referrer header or a shared machine)
const MFA_CHALLENGE_TTL = '5m';

const MFA_ISSUER = 'OrderSail';

export type MfaChallengeMethod = 'passkey' | 'totp' | 'recovery';

interface MfaChallengeResult {
  mfaRequired: true;
  challengeToken: string;
  methods: MfaChallengeMethod[];
}

// What a password sign-in comes to: a Session, or — when the User holds a
// Factor — a challenge that has to be completed before there is one. A
// password accepted with a Factor still owed is NOT a Session.
//
// Every sign-in operation in this class (and PasskeysService's two) ends by
// asking SessionsService to start the Session and returns the pair it gets
// back. None of them assembles a claim or knows what a refresh-token family
// is; the controller's only remaining job is to put the refresh token in the
// cookie (respondWithSession).
type SignInResult = ({ mfaRequired: false } & TokenPair) | MfaChallengeResult;

// the callback param drizzle hands a `db.transaction()` caller — same
// query-builder surface as `db` itself, scoped to one transaction
type DbTransaction = Parameters<Parameters<(typeof Db)['transaction']>[0]>[0];

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: typeof Db,
    private jwtService: JwtService,
    private usersService: UsersService,
    private accountService: AccountService,
    private permissionsService: PermissionsService,
    private emailService: EmailService,
    private sessionsService: SessionsService,
    private factorState: FactorStateService,
  ) {}

  // Who the caller is *now*. Email and name are read from the User row, not
  // from the token: they're editable (PATCH /auth/me/profile), the token
  // doesn't carry them, and when it did every refresh copied the old value
  // forward — the sidebar kept showing a name the User had already changed
  // until they signed out (OS-527).
  //
  // emailVerified and mfaEnrollmentSatisfied are the deliberate exception,
  // reported off the token rather than the row. merchant-web reads them to
  // learn whether it is gated, and what gates a request is the claim the
  // guards read — so this must say what the token says, or the dashboard
  // would route a caller into pages that 403 them. They can't stay stale for
  // long: the moments they change re-mint the token (verifyEmail,
  // confirmMfa, passkey registration).
  async me(user: AuthenticatedUser): Promise<AuthMe> {
    const [row] = await this.db
      .select({
        email: usersTable.email,
        firstName: usersTable.firstname,
        lastName: usersTable.lastname,
      })
      .from(usersTable)
      .where(eq(usersTable.id, user.sub));
    // an access token outlives the row it was minted from — a deleted User
    // (a revoked invite, say) is a 401, which sends the client to refresh,
    // where the Session is refused for good
    if (!row) {
      throw new UnauthorizedException();
    }

    const permissions =
      await this.permissionsService.getEffectivePermissionKeys(user.sub);
    const factors = await this.getFactorState(user.sub);
    return {
      userId: user.sub,
      email: row.email,
      firstName: row.firstName,
      lastName: row.lastName,
      accountId: user.accountId,
      emailVerified: user.emailVerified,
      totpEnabled: factors.totpConfirmed,
      passkeyCount: factors.passkeyCount,
      hasMfaFactor: factors.hasMfaFactor,
      mfaEnrollmentSatisfied: user.mfaEnrollmentSatisfied,
      permissions: [...permissions].sort(),
    };
  }

  async signin(signinDto: SignInDto): Promise<SignInResult> {
    const user = await this.usersService.getByEmail(signinDto.email);

    // staff created from the dashboard have no password until they join via
    // an invite link — treat that the same as a wrong password, not a crash
    if (!user || !user.password) {
      throw new UnauthorizedException();
    }

    if (!(await bcrypt.compare(signinDto.password, user.password))) {
      throw new UnauthorizedException();
    }

    const factors = await this.getFactorState(user.id);

    // any confirmed second factor means the password alone isn't enough —
    // withhold tokens and hand back a short-lived challenge instead. An
    // *unconfirmed* TOTP enrollment (mid-setup, never finished) doesn't
    // count: there's nothing to challenge with yet.
    //
    // Widened from TOTP-only to any factor now that the challenge step can
    // actually accept a passkey assertion (OS-488) and offer it (OS-489).
    // The matching rule in toFactorClaims() moves in the same commit,
    // deliberately: a factor counts as enrollment exactly when sign-in can
    // make the user prove it.
    if (factors.hasMfaFactor) {
      return {
        mfaRequired: true,
        challengeToken: await this.createMfaChallengeToken(user.id),
        // what the challenge step should actually offer. Recovery codes are
        // always accepted alongside whatever else is listed — they're the
        // way through when the factor itself is unavailable.
        methods: [
          ...(factors.passkeyCount > 0 ? (['passkey'] as const) : []),
          'totp' as const,
          'recovery' as const,
        ],
      };
    }

    return {
      mfaRequired: false,
      ...(await this.sessionsService.start(user.id)),
    };
  }

  // Factor reads live in FactorStateService — SessionsService needs them
  // too, and can't reach them through this class without a dependency cycle.
  // Kept here as pass-throughs so PasskeysService and MfaFactorGuard, which
  // already hold an AuthService, don't grow a second dependency for one call.
  async getFactorState(
    userId: number,
    tx?: DbTransaction,
  ): Promise<FactorState> {
    return this.factorState.getFactorState(userId, tx);
  }

  // Serializes every read-then-mutate of this user's factors — registering a
  // passkey, removing one, disabling TOTP, regenerating recovery codes.
  // They live in two tables and two services, so there is no single row or
  // constraint to hang the invariant on; the user row is the one thing they
  // all share. Callers must hold this for the whole check-and-write, or the
  // "never go to zero factors" rule is only true when nobody double-clicks.
  async lockUserFactors(tx: DbTransaction, userId: number): Promise<void> {
    await tx
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .for('update');
  }

  async getFactorRequirement(
    userId: number,
    tx?: DbTransaction,
  ): Promise<'account' | 'user' | null> {
    return this.factorState.getFactorRequirement(userId, tx);
  }

  private async createMfaChallengeToken(userId: number): Promise<string> {
    return await this.sign(
      { sub: userId, typ: 'mfa_challenge' },
      MFA_CHALLENGE_TTL,
    );
  }

  // Exchanges a signin()-issued challenge for real tokens once the caller
  // proves the second factor (TOTP or an unused recovery code). The
  // challenge token's own signature/expiry is the only thing standing in
  // for "the password was already checked" — it carries no other claims.
  // Resolves a signin()-issued challenge token to the user it was minted
  // for. Public because PasskeysService exchanges the same token on the
  // passkey branch of the challenge (OS-488) — the `typ` check in particular
  // must not be reimplemented there, since an access token presented here
  // would otherwise be accepted as proof of a second factor.
  async resolveMfaChallengeToken(
    challengeToken: string,
  ): Promise<typeof usersTable.$inferSelect> {
    let payload: { sub: number; typ: string };
    try {
      payload = await this.jwtService.verifyAsync(challengeToken);
    } catch {
      throw new UnauthorizedException('Invalid or expired challenge');
    }

    if (payload.typ !== 'mfa_challenge') {
      throw new UnauthorizedException('Invalid or expired challenge');
    }

    const [user] = await this.db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, payload.sub));
    // The token outlives signin()'s own deactivation check by up to
    // MFA_CHALLENGE_TTL, so a User deactivated inside that window is refused
    // at this point, with the same message as every other failure (no oracle
    // for "this account was just switched off").
    //
    // No longer the only thing in the way — SessionsService.start refuses a
    // deactivated User on every path (OS-527) — but it stays, and not only
    // as a regression guard: refusing HERE is what stops a deactivated
    // User's recovery code or passkey challenge being spent on a sign-in
    // that was never going to succeed.
    if (!user || user.deactivatedAt) {
      throw new UnauthorizedException('Invalid or expired challenge');
    }
    return user;
  }

  async verifyMfaChallenge(
    challengeToken: string,
    code: string,
  ): Promise<TokenPair> {
    const user = await this.resolveMfaChallengeToken(challengeToken);

    const [mfa] = await this.db
      .select()
      .from(userMfaTable)
      .where(eq(userMfaTable.userId, user.id));

    // A confirmed TOTP row gates the TOTP branch only — NOT the recovery
    // branch. Recovery codes belong to the user rather than to a factor
    // (OS-485 issues them for a first factor of either kind), so requiring
    // TOTP before considering one locks out exactly the person who needs it:
    // a passkey-only user who can't present their passkey. That was
    // unreachable until OS-489 started challenging them, and it failed with
    // "Invalid or expired challenge", which reads like the challenge expired
    // rather than "your only fallback doesn't work here".
    const isValidTotp =
      mfa?.confirmedAt != null &&
      authenticator.verify({
        token: code,
        secret: decryptMfaSecret(mfa.secret),
      });
    const isValidRecoveryCode =
      !isValidTotp && (await this.consumeRecoveryCode(user.id, code));

    if (!isValidTotp && !isValidRecoveryCode) {
      throw new UnauthorizedException('Invalid code');
    }

    // The Factor is proven, so now — and only now — there is a Session. Its
    // enrollment claim needs no help from here: a User is only ever
    // challenged because they hold a Factor, and holding one is what
    // satisfies any requirement (FactorStateService.toFactorClaims).
    return this.sessionsService.start(user.id);
  }

  // The update is conditioned on isNull(usedAt) too, not just the row id —
  // two concurrent requests presenting the same code both pass the read
  // above, but Postgres serializes the UPDATEs on that row: the second one
  // re-evaluates its WHERE against the just-committed row and finds no
  // match, so .returning() comes back empty and only one request wins.
  private async consumeRecoveryCode(
    userId: number,
    code: string,
  ): Promise<boolean> {
    const unusedCodes = await this.db
      .select()
      .from(userMfaRecoveryCodesTable)
      .where(
        and(
          eq(userMfaRecoveryCodesTable.userId, userId),
          isNull(userMfaRecoveryCodesTable.usedAt),
        ),
      );

    for (const row of unusedCodes) {
      if (await bcrypt.compare(code, row.codeHash)) {
        const [claimed] = await this.db
          .update(userMfaRecoveryCodesTable)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(userMfaRecoveryCodesTable.id, row.id),
              isNull(userMfaRecoveryCodesTable.usedAt),
            ),
          )
          .returning();
        if (claimed) return true;
      }
    }
    return false;
  }

  // Generates a new unconfirmed TOTP secret and returns its otpauth:// URI
  // for the caller to add to an authenticator app. Requires a verified email
  // (a second factor shouldn't be lockable-in before proving control of the
  // inbox — see OS-470) and blocks re-enrolling over an already-confirmed
  // factor (disable first).
  async enrollMfa(userId: number): Promise<{ otpauthUrl: string }> {
    const [user] = await this.db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    if (!user) {
      throw new UnauthorizedException();
    }
    if (!user.emailVerifiedAt) {
      throw new ForbiddenException('Verify your email before enabling MFA');
    }

    const [existing] = await this.db
      .select({ confirmedAt: userMfaTable.confirmedAt })
      .from(userMfaTable)
      .where(eq(userMfaTable.userId, userId));
    if (existing?.confirmedAt) {
      throw new ConflictException(
        'MFA is already enabled — disable it first to re-enroll',
      );
    }

    const secret = authenticator.generateSecret();
    const encryptedSecret = encryptMfaSecret(secret);

    await this.db
      .insert(userMfaTable)
      .values({ userId, secret: encryptedSecret })
      .onConflictDoUpdate({
        target: userMfaTable.userId,
        set: {
          secret: encryptedSecret,
          confirmedAt: null,
          updatedAt: new Date(),
        },
      });

    return { otpauthUrl: authenticator.keyuri(user.email, MFA_ISSUER, secret) };
  }

  // Public because PasskeysService applies the same re-authentication bar
  // before removing a credential.
  async verifyPassword(userId: number, password: string): Promise<void> {
    const [user] = await this.db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    if (!user || !user.password) {
      throw new UnauthorizedException();
    }
    if (!(await bcrypt.compare(password, user.password))) {
      throw new UnauthorizedException();
    }
  }

  // Verifies the current password (this activates a second factor — the
  // same reauthentication bar as disabling one, see disableMfa) and the
  // first code against the pending secret, then activates it and issues the
  // one and only batch of recovery codes for this enrollment — the caller
  // must save them now, they're never shown again. The state update and the
  // code replacement run in one transaction, with the user_mfa row locked
  // for its duration, so a concurrent confirm/regenerate for the same user
  // can't interleave with this one.
  //
  // Also returns a re-minted access token: this caller may have been gated
  // into forced enrollment (mfaEnrollmentSatisfied: false baked into the
  // token they hold), and shouldn't stay stuck behind a gate they've just
  // cleared until their next refresh. Minted after the transaction commits,
  // so the claim is computed from the Factor that now exists.
  async confirmMfa(
    userId: number,
    code: string,
    password: string,
  ): Promise<{ recoveryCodes: string[]; access_token: string }> {
    await this.verifyPassword(userId, password);

    const recoveryCodes = await this.db.transaction(async (tx) => {
      const [mfa] = await tx
        .select()
        .from(userMfaTable)
        .where(eq(userMfaTable.userId, userId))
        .for('update');
      if (!mfa || mfa.confirmedAt) {
        throw new UnauthorizedException('No pending MFA enrollment');
      }

      if (
        !authenticator.verify({
          token: code,
          secret: decryptMfaSecret(mfa.secret),
        })
      ) {
        throw new UnauthorizedException('Invalid code');
      }

      await tx
        .update(userMfaTable)
        .set({ confirmedAt: new Date(), updatedAt: new Date() })
        .where(eq(userMfaTable.id, mfa.id));

      return this.issueRecoveryCodes(tx, userId);
    });

    return {
      recoveryCodes,
      access_token: await this.sessionsService.remintAccessToken(userId),
    };
  }

  // Requires current-password re-entry — standard practice for removing a
  // second factor, since the whole point of MFA is that a password alone
  // shouldn't be enough to weaken an account's security. Refused outright
  // while a factor is required of this user (account-wide OS-473, or the
  // invited-staff stamp OS-494) — otherwise a caller could
  // self-disable and keep full access for the rest of their current
  // access token's 8h lifetime (mfaEnrollmentSatisfied is only
  // recomputed on refresh, not per request), silently defeating the
  // account-wide requirement. An Owner must turn the requirement off
  // first if this user genuinely needs to stop using MFA.
  async disableMfa(userId: number, password: string): Promise<void> {
    await this.verifyPassword(userId, password);

    // One locked transaction for the whole check-and-delete: otherwise this
    // races PasskeysService.remove (different table, different service) and
    // both can conclude a factor will remain while each removes the last of
    // its own kind.
    await this.db.transaction(async (tx) => {
      await this.lockUserFactors(tx, userId);

      // Refused only when this would leave the user with nothing. Since
      // OS-485 a passkey is also a factor, so someone holding both can drop
      // TOTP and still satisfy the requirement — what must not happen is
      // going to zero.
      const requirement = await this.getFactorRequirement(userId, tx);
      if (requirement) {
        const { passkeyCount } = await this.getFactorState(userId, tx);
        if (passkeyCount === 0) {
          throw new ConflictException(
            requirement === 'account'
              ? 'Your account requires MFA — add a passkey first, or ask an Owner to turn off the requirement'
              : 'Your sign-in needs a second factor — add a passkey first, then you can remove the authenticator',
          );
        }
      }

      await tx
        .delete(userMfaRecoveryCodesTable)
        .where(eq(userMfaRecoveryCodesTable.userId, userId));
      await tx.delete(userMfaTable).where(eq(userMfaTable.userId, userId));
    });
  }

  // Requires current-password re-entry (see confirmMfa) — a stolen bearer
  // token alone shouldn't be enough to mint a fresh recovery-code backdoor
  // for an account that already has MFA confirmed.
  async regenerateRecoveryCodes(
    userId: number,
    password: string,
  ): Promise<{ recoveryCodes: string[] }> {
    await this.verifyPassword(userId, password);

    return this.db.transaction(async (tx) => {
      // Locks the user row, not user_mfa: recovery codes belong to the user
      // rather than to a particular factor, and a passkey-only user has no
      // user_mfa row to lock at all. Still serializes two concurrent
      // regenerates, which is what the FOR UPDATE was for — otherwise both
      // callers are shown a batch and only the second one's is live.
      await this.lockUserFactors(tx, userId);

      const { hasMfaFactor } = await this.getFactorState(userId, tx);
      if (!hasMfaFactor) {
        throw new UnauthorizedException('MFA is not enabled');
      }

      return { recoveryCodes: await this.issueRecoveryCodes(tx, userId) };
    });
  }

  // Public because registering a *first* factor of either kind issues the
  // batch — before passkeys this was only ever reachable from confirmMfa.
  async issueRecoveryCodes(
    tx: DbTransaction,
    userId: number,
  ): Promise<string[]> {
    const codes = generateRecoveryCodes();

    await tx
      .delete(userMfaRecoveryCodesTable)
      .where(eq(userMfaRecoveryCodesTable.userId, userId));
    await tx.insert(userMfaRecoveryCodesTable).values(
      await Promise.all(
        codes.map(async (code) => ({
          userId,
          codeHash: await bcrypt.hash(code, 10),
        })),
      ),
    );

    return codes;
  }

  async signup(signupDto: SignUpDto): Promise<TokenPair> {
    try {
      const { owner: user } = await this.accountService.provision(signupDto);

      // best-effort, outside provision()'s transaction — an email that fails
      // to send (see EmailService's own try/catch) shouldn't roll back a
      // successful signup; the account can always resend
      await this.issueVerificationEmail(user);

      // Signup leaves the new Owner signed in. The Session's claims come out
      // of the rows provision() just wrote: unverified (the email above is
      // still unread) and ungated — requireMfaAt is never set at creation,
      // and signup doesn't stamp factorRequiredAt (Owners are gated at the
      // money actions instead, OS-492).
      return await this.sessionsService.start(user.id);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('Email already in use');
      }
      throw err;
    }
  }

  async acceptInvite(dto: AcceptInviteDto): Promise<TokenPair> {
    const invite = await this.usersService.getByInviteToken(dto.token);

    if (!invite || invite.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired invite');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const user = await this.usersService.activate(
      invite.user.id,
      hashedPassword,
    );

    if (!user) {
      throw new UnauthorizedException('Invalid or expired invite');
    }

    // Accepting the invite leaves the new staff User signed in, and both of
    // the Session's gate claims follow from what activate() just wrote.
    // Clicking the emailed link already proves ownership of the address, so
    // it set emailVerifiedAt alongside the password — verified from the
    // first token. It also stamped factorRequiredAt (OS-494), and nobody can
    // hold a Factor before they have a password, so a joining staff User is
    // never enrollment-satisfied here and goes straight to setting one up.
    // It's the same computation refreshTokens() runs, which is what keeps
    // that gate standing after the first navigation.
    return this.sessionsService.start(user.id);
  }

  // Verifies the emailed token for the *signed-in* caller and re-mints only
  // their access token with emailVerified: true. The link proves control of
  // the inbox, never identity — it must not create a session, or it becomes
  // a password-free login link for anyone the email reaches (forwards,
  // shared inboxes, link scanners). A token belonging to a different user
  // is rejected without being consumed, so its owner can still use it.
  async verifyEmail(userId: number, token: string) {
    const [verification] = await this.db
      .select()
      .from(userEmailVerificationsTable)
      .where(eq(userEmailVerificationsTable.token, hashToken(token)));

    // 400, not 401: the caller is authenticated, so a 401 here would read as
    // "your session expired" to the client's refresh-and-retry logic
    if (!verification || verification.expiresAt < new Date()) {
      throw new BadRequestException('Invalid or expired token');
    }
    if (verification.userId !== userId) {
      throw new ForbiddenException(
        'This verification link belongs to a different account',
      );
    }

    const [user] = await this.db
      .update(usersTable)
      .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(usersTable.id, verification.userId))
      .returning({ id: usersTable.id });

    if (!user) {
      throw new BadRequestException('Invalid or expired token');
    }

    await this.db
      .delete(userEmailVerificationsTable)
      .where(eq(userEmailVerificationsTable.id, verification.id));

    // A re-mint, not a Session (see above): the access token the caller
    // holds says emailVerified: false, and leaving it until their next
    // refresh would bounce them straight back to the verify-email lobby.
    return {
      access_token: await this.sessionsService.remintAccessToken(user.id),
    };
  }

  // Silent no-op if the account is gone or already verified — reachable by
  // any authenticated caller for their own account (see
  // AuthController.resendVerification), so there's no email to leak
  // existence of here the way requestPasswordReset has to guard against.
  async resendVerification(userId: number): Promise<void> {
    const [user] = await this.db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId));

    if (!user || user.emailVerifiedAt) return;

    await this.issueVerificationEmail(user);
  }

  private async issueVerificationEmail(user: {
    id: number;
    email: string;
    firstname: string;
  }): Promise<void> {
    const token = generateToken(32);
    const tokenHash = hashToken(token);
    await this.db
      .insert(userEmailVerificationsTable)
      .values({
        userId: user.id,
        token: tokenHash,
        expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
      })
      .onConflictDoUpdate({
        target: userEmailVerificationsTable.userId,
        set: {
          token: tokenHash,
          expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
        },
      });

    const verifyUrl = `${env.MERCHANT_WEB_URL}/verify-email?token=${token}`;
    await this.emailService.sendVerificationEmail(user.email, {
      firstName: user.firstname,
      verifyUrl,
    });
  }

  // Always resolves with no signal either way — a distinct response for
  // "no account with that email" vs "email sent" would let an attacker
  // enumerate registered accounts. A pending invite (password IS NULL) is
  // treated the same as "no account": there's no password to reset yet,
  // that user needs the invite link instead.
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.usersService.getByEmail(email);
    if (!user || !user.password) return;

    const token = generateToken(32);
    const tokenHash = hashToken(token);
    await this.db
      .insert(userPasswordResetsTable)
      .values({
        userId: user.id,
        token: tokenHash,
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      })
      .onConflictDoUpdate({
        target: userPasswordResetsTable.userId,
        set: {
          token: tokenHash,
          expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
        },
      });

    const resetUrl = `${env.MERCHANT_WEB_URL}/reset-password?token=${token}`;
    await this.emailService.sendPasswordResetEmail(user.email, {
      firstName: user.firstname,
      resetUrl,
    });
  }

  // Sets a new password, consumes the reset token, and revokes every
  // existing refresh-token family for the user — unlike a normal token
  // rotation (which only kills the one family being rotated), a password
  // reset must kill every live session, since the whole point is "whoever
  // had the old password should be logged out everywhere."
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const [reset] = await this.db
      .select()
      .from(userPasswordResetsTable)
      .where(eq(userPasswordResetsTable.token, hashToken(token)));

    if (!reset || reset.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await this.db
      .update(usersTable)
      .set({ password: hashedPassword, updatedAt: new Date() })
      .where(eq(usersTable.id, reset.userId));

    await this.db
      .delete(userPasswordResetsTable)
      .where(eq(userPasswordResetsTable.id, reset.id));

    await this.sessionsService.revokeAll(reset.userId);
  }

  // Changes the password of a caller who is already signed in — the
  // self-service counterpart to resetPassword, which exists for someone who
  // can't sign in at all. The current password is the re-authentication,
  // checked first and on its own, so a caller holding a stolen access token
  // but not the password can't get as far as touching the row (the same bar
  // disableMfa and passkey removal apply).
  //
  // Then every other session is revoked and the caller's own is rotated in
  // place — see SessionsService.revokeOthersAndRotate for why it is rotated
  // rather than spared or killed.
  //
  // Returns the replacement pair; the caller must set the new refresh cookie
  // (see AuthController.changePassword), which is the same contract
  // token/refresh already has.
  async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
    callerRefreshToken: string | undefined,
  ): Promise<TokenPair> {
    try {
      await this.verifyPassword(userId, currentPassword);
    } catch (err) {
      // Rethrown with the field named rather than left as a bare 401. The
      // caller is already authenticated, so saying which input was wrong
      // enumerates nothing — and without it the dashboard can't tell this
      // apart from an expired access token, which it would answer by
      // silently refreshing instead of reporting the mistake.
      if (err instanceof UnauthorizedException) {
        throw new UnauthorizedException('Current password is incorrect');
      }
      throw err;
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await this.db
      .update(usersTable)
      .set({ password: hashedPassword, updatedAt: new Date() })
      .where(eq(usersTable.id, userId));

    return this.sessionsService.revokeOthersAndRotate(
      userId,
      callerRefreshToken,
    );
  }

  // Signs the MFA challenge token and nothing else — access and refresh
  // tokens are SessionsService's. A challenge is not a Session.
  private async sign(
    payload: Record<string, unknown>,
    expiresIn: JwtSignOptions['expiresIn'],
  ) {
    return await this.jwtService.signAsync(payload, { expiresIn });
  }
}
