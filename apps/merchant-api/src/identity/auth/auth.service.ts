import { randomUUID } from 'node:crypto';
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
import { RolesService } from '../roles/roles.service';
import { PermissionsService } from '../permissions/permissions.service';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { type AuthenticatedUser } from 'src/shared/auth/decorators';
import { type TokenClaims } from './token-claims';
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
  accountApiKeysTable,
  accountsTable,
  and,
  count,
  type db as Db,
  eq,
  isNull,
  isUniqueViolation,
  ne,
  userEmailVerificationsTable,
  userMfaRecoveryCodesTable,
  userMfaTable,
  userPasskeysTable,
  userPasswordResetsTable,
  userRefreshTokensTable,
  usersTable,
} from 'db/identity';
import { locationsTable } from 'db/stock';
import * as bcrypt from 'bcryptjs';
import { generateApiKey } from '../api-keys/api-keys.util';

// deliberately much shorter than the 7-day invite TTL — an existing active
// user can always request a fresh link, so there's no cost to expiring fast
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

// no urgency signal the way a password reset has ("someone might be taking
// over your account right now") — a generous window is fine
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

// a just-rotated-out refresh token, re-presented within this window, replays
// the same replacement pair instead of revoking the family — see
// packages/db/src/schema/user-refresh-tokens.ts for why this exists
const REFRESH_GRACE_WINDOW_MS = 10_000;

// long enough to type a code in, short enough that a challenge token isn't
// worth much if it leaks (e.g. via a referrer header or a shared machine)
const MFA_CHALLENGE_TTL = '5m';

const MFA_ISSUER = 'OrderSail';

export interface SignInSuccessResult {
  mfaRequired: false;
  userId: number;
  email: string;
  accountId: number;
  firstName: string;
  lastName: string;
  emailVerified: boolean;
  mfaEnrollmentSatisfied: boolean;
  hasMfaFactor: boolean;
  access_token: string;
}

// what second factors a user holds, across both factor tables
interface FactorState {
  totpConfirmed: boolean;
  passkeyCount: number;
  hasMfaFactor: boolean;
}

// the two factor-derived token claims — see getFactorClaims()
interface FactorClaims {
  hasMfaFactor: boolean;
  mfaEnrollmentSatisfied: boolean;
}

export type MfaChallengeMethod = 'passkey' | 'totp' | 'recovery';

interface MfaChallengeResult {
  mfaRequired: true;
  challengeToken: string;
  methods: MfaChallengeMethod[];
}

type SignInResult = SignInSuccessResult | MfaChallengeResult;

// A successful sign-in already carries every claim the caller's refresh
// token needs — AuthController mints one right after signin/signup/
// accept-invite/verify-mfa, and this keeps that mapping in one place
// instead of four identical argument lists.
//
// Typed structurally rather than as SignInSuccessResult because signup()
// and acceptInvite() return the same claim-bearing fields without the
// `mfaRequired` discriminant.
export function claimsFromSignInResult(
  result: Omit<SignInSuccessResult, 'mfaRequired' | 'access_token'>,
): TokenClaims {
  return {
    sub: result.userId,
    email: result.email,
    accountId: result.accountId,
    firstName: result.firstName,
    lastName: result.lastName,
    emailVerified: result.emailVerified,
    mfaEnrollmentSatisfied: result.mfaEnrollmentSatisfied,
    hasMfaFactor: result.hasMfaFactor,
  };
}

// the callback param drizzle hands a `db.transaction()` caller — same
// query-builder surface as `db` itself, scoped to one transaction
type DbTransaction = Parameters<Parameters<(typeof Db)['transaction']>[0]>[0];

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: typeof Db,
    private jwtService: JwtService,
    private usersService: UsersService,
    private rolesService: RolesService,
    private permissionsService: PermissionsService,
    private emailService: EmailService,
  ) {}

  async me(user: AuthenticatedUser): Promise<AuthMe> {
    const permissions =
      await this.permissionsService.getEffectivePermissionKeys(user.sub);
    const factors = await this.getFactorState(user.sub);
    return {
      userId: user.sub,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
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

    return this.buildSignInSuccess(
      user,
      await this.toFactorClaims(user.id, factors),
    );
  }

  // What second factors this user actually holds. A "factor" is a confirmed
  // TOTP row OR at least one passkey — the two live in different tables
  // (user_mfa is one-per-user, user_passkeys is many), so every "do they
  // have one" question goes through here rather than reading either table
  // directly.
  //
  // Returns the components and not just the boolean because callers need
  // different parts: the signin challenge branch cares specifically about
  // TOTP, /auth/me reports passkeyCount, and the claim computation only
  // wants hasMfaFactor.
  // Public because PasskeysService needs the same answer when deciding
  // whether removing a credential would leave the user with no factor.
  //
  // Takes an optional transaction so a caller that is *mutating* factors can
  // read the count inside its own transaction, behind the same lock. Reading
  // it outside is a time-of-check/time-of-use hole: two concurrent removals
  // each see two factors, each decide one will remain, and the user lands on
  // zero. See lockUserFactors().
  async getFactorState(
    userId: number,
    tx?: DbTransaction,
  ): Promise<FactorState> {
    const executor = tx ?? this.db;
    const [[mfa], [passkeys]] = await Promise.all([
      executor
        .select({ confirmedAt: userMfaTable.confirmedAt })
        .from(userMfaTable)
        .where(eq(userMfaTable.userId, userId)),
      executor
        .select({ value: count() })
        .from(userPasskeysTable)
        .where(eq(userPasskeysTable.userId, userId)),
    ]);

    const totpConfirmed = mfa?.confirmedAt != null;
    const passkeyCount = passkeys?.value ?? 0;
    return {
      totpConfirmed,
      passkeyCount,
      hasMfaFactor: totpConfirmed || passkeyCount > 0,
    };
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

  private async getFactorClaims(userId: number): Promise<FactorClaims> {
    const factors = await this.getFactorState(userId);
    return this.toFactorClaims(userId, factors);
  }

  // Whether this user must hold a factor, and on whose say-so. Two sources,
  // either is enough: the account-wide policy an Owner switches on
  // (accounts.requireMfaAt, OS-473) and the per-user stamp an invited staff
  // member gets when they join (users.factorRequiredAt, OS-494). The one
  // place the rule lives — the enrollment claim and both last-factor checks
  // read it, so they can't drift apart. Returns which source applies only so
  // a refusal can say something true about how to lift it; 'account' wins
  // when both are set because that's the one an Owner can act on.
  async getFactorRequirement(
    userId: number,
    tx?: DbTransaction,
  ): Promise<'account' | 'user' | null> {
    const [row] = await (tx ?? this.db)
      .select({
        requireMfaAt: accountsTable.requireMfaAt,
        factorRequiredAt: usersTable.factorRequiredAt,
      })
      .from(usersTable)
      .innerJoin(accountsTable, eq(usersTable.accountId, accountsTable.id))
      .where(eq(usersTable.id, userId));

    if (row?.requireMfaAt) return 'account';
    if (row?.factorRequiredAt) return 'user';
    return null;
  }

  // The two token claims that depend on factor state.
  //
  // hasMfaFactor: does the user hold any factor at all — read by the
  // per-route gate (OS-492) for money/access-sensitive actions.
  //
  // mfaEnrollmentSatisfied: is anything *blocking* this user — a factor is
  // required of them (account-wide policy, or the stamp an invited staff
  // member carries — see getFactorRequirement) and they haven't enrolled.
  // Nothing requires it -> trivially satisfied, even with no factor.
  //
  // These two are now the same question, and were deliberately not always
  // so: a factor satisfies an account-wide MFA requirement exactly when
  // sign-in can make the user prove it. Between OS-484 and OS-489 enrollment
  // counted only a confirmed TOTP factor, because nothing could verify a
  // passkey yet — counting one would have left a require-MFA account
  // reachable with a password alone, the user holding a factor nobody ever
  // asked them to present. Keep them moving together if a third factor type
  // is ever added.
  private async toFactorClaims(
    userId: number,
    factors: FactorState,
  ): Promise<FactorClaims> {
    const requirement = await this.getFactorRequirement(userId);

    return {
      hasMfaFactor: factors.hasMfaFactor,
      mfaEnrollmentSatisfied: !requirement || factors.hasMfaFactor,
    };
  }

  // Public because the passkey branch of the challenge (OS-488) finishes
  // the same way: a factor the caller just proved possession of always
  // satisfies an account-wide requirement.
  async buildSignInSuccess(
    user: {
      id: number;
      email: string;
      accountId: number;
      firstname: string;
      lastname: string;
      emailVerifiedAt: Date | null;
    },
    flags: FactorClaims,
  ): Promise<SignInSuccessResult> {
    const emailVerified = user.emailVerifiedAt !== null;
    const { mfaEnrollmentSatisfied, hasMfaFactor } = flags;
    const access_token = await this.createAccessToken({
      sub: user.id,
      email: user.email,
      accountId: user.accountId,
      firstName: user.firstname,
      lastName: user.lastname,
      emailVerified,
      mfaEnrollmentSatisfied,
      hasMfaFactor,
    });

    return {
      mfaRequired: false,
      userId: user.id,
      email: user.email,
      accountId: user.accountId,
      firstName: user.firstname,
      lastName: user.lastname,
      emailVerified,
      mfaEnrollmentSatisfied,
      hasMfaFactor,
      access_token,
    };
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
    if (!user) {
      throw new UnauthorizedException('Invalid or expired challenge');
    }
    return user;
  }

  async verifyMfaChallenge(
    challengeToken: string,
    code: string,
  ): Promise<SignInSuccessResult> {
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

    // a confirmed factor the caller just proved possession of always
    // satisfies any account-wide MFA requirement
    return this.buildSignInSuccess(user, {
      mfaEnrollmentSatisfied: true,
      hasMfaFactor: true,
    });
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
  async confirmMfa(
    userId: number,
    code: string,
    password: string,
  ): Promise<{ recoveryCodes: string[] }> {
    await this.verifyPassword(userId, password);

    return this.db.transaction(async (tx) => {
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

      return { recoveryCodes: await this.issueRecoveryCodes(tx, userId) };
    });
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

  async signup(signupDto: SignUpDto) {
    try {
      const user = await this.db.transaction(async (tx) => {
        const [account] = await tx
          .insert(accountsTable)
          .values({
            name: signupDto.businessName,
            phone: signupDto.phone,
            email: signupDto.email,
          })
          .returning();

        await tx.insert(accountApiKeysTable).values({
          accountId: account.id,
          key: generateApiKey(),
        });

        // products need somewhere to hold stock — every account starts
        // with a single seeded location, see locationsTable
        await tx.insert(locationsTable).values({
          accountId: account.id,
          name: 'Default',
        });

        const hashedPassword = await bcrypt.hash(signupDto.password, 10);

        const [user] = await tx
          .insert(usersTable)
          .values({
            firstname: signupDto.firstName,
            lastname: signupDto.lastName,
            email: signupDto.email,
            password: hashedPassword,
            accountId: account.id,
          })
          .returning();

        // every account starts with a non-deletable "Owner" role holding
        // every permission, assigned to the account's first user
        await this.rolesService.createSystemRole(tx, account.id, user.id);

        return user;
      });

      // best-effort, outside the transaction — an email that fails to send
      // (see EmailService's own try/catch) shouldn't roll back a
      // successful signup; the account can always resend
      await this.issueVerificationEmail(user);

      // brand-new account, created moments ago — requireMfaAt is never set
      // at creation, so there's nothing to satisfy yet
      const access_token = await this.createAccessToken({
        sub: user.id,
        email: user.email,
        accountId: user.accountId,
        firstName: user.firstname,
        lastName: user.lastname,
        emailVerified: false,
        mfaEnrollmentSatisfied: true,
        hasMfaFactor: false,
      });

      return {
        userId: user.id,
        email: user.email,
        accountId: user.accountId,
        firstName: user.firstname,
        lastName: user.lastname,
        emailVerified: false,
        mfaEnrollmentSatisfied: true,
        hasMfaFactor: false,
        access_token,
      };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('Email already in use');
      }
      throw err;
    }
  }

  async acceptInvite(dto: AcceptInviteDto) {
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

    // clicking the emailed invite link already proves ownership of this
    // address — UsersService.activate() sets emailVerifiedAt alongside the
    // password, so this is always true here, not read back from `user`
    //
    // activate() also stamped factorRequiredAt (OS-494), so a joining staff
    // member is never satisfied here — they can't hold a factor before they
    // have a password. Computed rather than hardcoded false so this stays
    // one rule with refreshTokens(), which is what keeps the gate standing
    // after the first navigation.
    const factorClaims = await this.getFactorClaims(user.id);
    const access_token = await this.createAccessToken({
      sub: user.id,
      email: user.email,
      accountId: user.accountId,
      firstName: user.firstName,
      lastName: user.lastName,
      emailVerified: true,
      ...factorClaims,
    });

    return {
      userId: user.id,
      email: user.email,
      accountId: user.accountId,
      firstName: user.firstName,
      lastName: user.lastName,
      emailVerified: true,
      ...factorClaims,
      access_token,
    };
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
      .returning();

    if (!user) {
      throw new BadRequestException('Invalid or expired token');
    }

    await this.db
      .delete(userEmailVerificationsTable)
      .where(eq(userEmailVerificationsTable.id, verification.id));

    // this user could never have a confirmed MFA factor yet (enrollMfa()
    // requires emailVerifiedAt already set), so this only ever depends on
    // whether the account requires MFA at all
    const factorClaims = await this.getFactorClaims(user.id);
    const access_token = await this.createAccessToken({
      sub: user.id,
      email: user.email,
      accountId: user.accountId,
      firstName: user.firstname,
      lastName: user.lastname,
      emailVerified: true,
      ...factorClaims,
    });

    return { access_token };
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

    await this.revokeAllFamiliesForUser(reset.userId);
  }

  // Changes the password of a caller who is already signed in — the
  // self-service counterpart to resetPassword, which exists for someone who
  // can't sign in at all. The current password is the re-authentication,
  // checked first and on its own, so a caller holding a stolen access token
  // but not the password can't get as far as touching the row (the same bar
  // disableMfa and passkey removal apply).
  //
  // Then EVERY live refresh token for this user is invalidated, the caller's
  // included. resetPassword already revokes unconditionally, and the usual
  // reason to change a password is believing it's compromised — leaving any
  // of them alive would make the self-service path weaker than the emailed
  // one. The threat this closes is a *copy* of the caller's own refresh
  // token: it lives in the caller's family, so merely sparing that family
  // would leave the attacker redeeming it for up to its full 7-day life.
  //
  // The caller still doesn't get signed out, because their family is rotated
  // rather than killed: the presented token is revoked and replaced in place,
  // exactly as an ordinary refresh does. Keeping the same family is what
  // preserves reuse detection — if the stolen copy is ever presented it hits
  // the replacedByJti path and takes the family down with it.
  //
  // Returns the replacement pair; the caller must set the new refresh cookie
  // (see AuthController.changePassword), which is the same contract
  // token/refresh already has.
  async changePassword(
    caller: AuthenticatedUser,
    currentPassword: string,
    newPassword: string,
    callerRefreshToken: string | undefined,
  ): Promise<{ access_token: string; refresh_token: string }> {
    try {
      await this.verifyPassword(caller.sub, currentPassword);
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
      .where(eq(usersTable.id, caller.sub));

    const callersOwn = await this.callersLiveRefreshRecord(
      caller.sub,
      callerRefreshToken,
    );

    // Spared here only so the rotation below can revoke-and-replace it; a
    // family killed outright has nothing left to rotate.
    await this.revokeAllFamiliesForUser(caller.sub, callersOwn?.familyId);

    // Recomputed from the database rather than copied off the access token
    // the caller presented, for the same reason refreshTokens does it.
    const claims = await this.freshClaims(caller);

    // No usable cookie (missing, expired, or already rotated out) leaves no
    // family to continue, so the caller starts a fresh one. They asked for
    // this while holding a valid access token and just proved they know the
    // password, so signing them out instead would be a gratuitous refusal.
    return callersOwn
      ? this.rotateRefreshRecord(callersOwn, claims)
      : {
          access_token: await this.createAccessToken(claims),
          refresh_token: await this.createRefreshToken(claims, randomUUID()),
        };
  }

  // "Sign out everywhere else" — the same sweep changePassword performs,
  // exposed on its own for someone who left a browser signed in somewhere
  // and doesn't want to rotate a password they still trust.
  //
  // The opposite intent to changePassword's, though: there the caller's own
  // family is spared only so it can be rotated (the threat being a *copy* of
  // their refresh token, which lives in that same family). Here nothing
  // suggests this browser's token is compromised, so its family is spared
  // and simply left running — no rotation, and so no new refresh cookie for
  // the controller to write back.
  //
  // Deliberately requires no password. Unlike disabling MFA or removing a
  // passkey, this only ever reduces access: the worst an attacker holding a
  // stolen access token achieves by calling it is signing the legitimate
  // user out, which is the very thing the legitimate user came here to do.
  //
  // No usable cookie (missing, expired, or already rotated out) leaves no
  // family to identify as "this one", so every family goes — this browser's
  // included — and the caller is then started on a brand-new one. Killing
  // their session instead would defeat the request: "sign out everywhere"
  // means everywhere *else*, and the person asking is explicitly the one who
  // wants to stay. changePassword's no-cookie path does exactly the same
  // thing, deliberately, so the two can't drift apart.
  //
  // Returns the caller's re-minted access token, always; `refresh_token` only
  // when a new family had to be started, which is the only case there's a
  // cookie for the controller to write back.
  async revokeOtherSessions(
    caller: AuthenticatedUser,
    callerRefreshToken: string | undefined,
  ): Promise<{ access_token: string; refresh_token?: string }> {
    const callersOwn = await this.callersLiveRefreshRecord(
      caller.sub,
      callerRefreshToken,
    );

    await this.revokeAllFamiliesForUser(caller.sub, callersOwn?.familyId);

    // Recomputed from the database rather than copied off the access token
    // the caller presented, for the same reason refreshTokens does it.
    const claims = await this.freshClaims(caller);

    // The spared family keeps running as-is: nothing here suggests this
    // browser's refresh token is compromised, so there's no reason to rotate
    // it and no replacement cookie to deliver. The fresh access token is
    // handed back either way so the response has one shape.
    return callersOwn
      ? { access_token: await this.createAccessToken(claims) }
      : {
          access_token: await this.createAccessToken(claims),
          refresh_token: await this.createRefreshToken(claims, randomUUID()),
        };
  }

  // The caller's own live refresh-token row, or null if the cookie never
  // reached us, names a row that isn't theirs, or names one that's already
  // revoked.
  //
  // Liveness matters: a cookie that's already been rotated out names a dead
  // row, and treating that row's family as "this browser's" would spare its
  // live successor — the very session the caller may be here to kill. The
  // userId check is belt-and-braces (revokeAllFamiliesForUser filters on
  // userId anyway, so a foreign family id can't match), kept so a token
  // belonging to somebody else can never be the one that's rotated instead
  // of revoked.
  private async callersLiveRefreshRecord(
    userId: number,
    callerRefreshToken: string | undefined,
  ) {
    const presented = callerRefreshToken
      ? await this.refreshRecordFor(callerRefreshToken)
      : null;

    return presented && presented.userId === userId && !presented.revokedAt
      ? presented
      : null;
  }

  // `exceptFamilyId` holds one family back from the sweep — the caller's
  // own, so that a session which asked for this revocation isn't taken down
  // by the same statement that services it. What happens to the spared
  // family is the caller's business: changePassword rotates it (so it ends
  // up retired anyway, but with a successor), while a plain "sign out
  // everywhere" leaves it running as-is. A family id belonging to some other
  // user is harmless — the userId filter means it can't match, so this can
  // never spare a session it wasn't meant to.
  private async revokeAllFamiliesForUser(
    userId: number,
    exceptFamilyId?: string | null,
  ): Promise<void> {
    await this.db
      .update(userRefreshTokensTable)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(userRefreshTokensTable.userId, userId),
          isNull(userRefreshTokensTable.revokedAt),
          ...(exceptFamilyId
            ? [ne(userRefreshTokensTable.familyId, exceptFamilyId)]
            : []),
        ),
      );
  }

  private async sign(
    payload: Record<string, unknown>,
    expiresIn: JwtSignOptions['expiresIn'],
  ) {
    return await this.jwtService.signAsync(payload, { expiresIn });
  }

  async createAccessToken(claims: TokenClaims) {
    return await this.sign({ ...claims, typ: 'access' }, '8h');
  }

  private async signRefreshToken(claims: TokenClaims, jti: string) {
    return await this.sign({ ...claims, typ: 'refresh', jti }, '7d');
  }

  // Allocates a fresh jti, records it against `familyId`, and signs a token
  // for it. `familyId` is fresh (randomUUID()) for a brand-new session
  // (signin/signup/accept-invite, see AuthController) and carried through
  // unchanged on every rotation (refreshTokens) — it's the unit reuse
  // detection revokes as a whole.
  private async mintRefreshToken(
    claims: TokenClaims,
    familyId: string,
  ): Promise<{ token: string; jti: string }> {
    const jti = randomUUID();
    await this.db
      .insert(userRefreshTokensTable)
      .values({ userId: claims.sub, jti, familyId });
    const token = await this.signRefreshToken(claims, jti);
    return { token, jti };
  }

  async createRefreshToken(
    claims: TokenClaims,
    familyId: string,
  ): Promise<string> {
    const { token } = await this.mintRefreshToken(claims, familyId);
    return token;
  }

  // The claim set for a caller, recomputed against the database rather than
  // carried over from whatever token they presented. deactivatedAt,
  // emailVerifiedAt and the factor claims are all baked in at mint time, so
  // trusting the presented token would carry a stale answer forward through
  // every later token instead of picking up a change made since.
  //
  // Only the identity fields ride along from `identity` — those can't drift
  // without a re-mint anyway.
  private async freshClaims(identity: AuthenticatedUser): Promise<TokenClaims> {
    const [userRow] = await this.db
      .select({
        deactivatedAt: usersTable.deactivatedAt,
        emailVerifiedAt: usersTable.emailVerifiedAt,
      })
      .from(usersTable)
      .where(eq(usersTable.id, identity.sub));
    if (!userRow || userRow.deactivatedAt) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    return {
      sub: identity.sub,
      email: identity.email,
      accountId: identity.accountId,
      firstName: identity.firstName,
      lastName: identity.lastName,
      emailVerified: userRow.emailVerifiedAt !== null,
      ...(await this.getFactorClaims(identity.sub)),
    };
  }

  // Exchanges one live refresh-token row for its successor in the same
  // family: mint the replacement, then revoke the old row and point it at
  // what replaced it. That back-pointer is what the grace window and reuse
  // detection in refreshTokens() read, so nothing else may retire a row.
  //
  // Shared by the ordinary rotation (refreshTokens) and the forced one
  // (changePassword) so the two can't drift into different notions of what
  // rotating a session means.
  private async rotateRefreshRecord(
    record: { id: number; familyId: string },
    claims: TokenClaims,
  ): Promise<{ access_token: string; refresh_token: string }> {
    const { token: refresh_token, jti: nextJti } = await this.mintRefreshToken(
      claims,
      record.familyId,
    );
    await this.db
      .update(userRefreshTokensTable)
      .set({ revokedAt: new Date(), replacedByJti: nextJti })
      .where(eq(userRefreshTokensTable.id, record.id));

    return {
      access_token: await this.createAccessToken(claims),
      refresh_token,
    };
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.db
      .update(userRefreshTokensTable)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(userRefreshTokensTable.familyId, familyId),
          isNull(userRefreshTokensTable.revokedAt),
        ),
      );
  }

  // Single-use: every call revokes the presented refresh token and issues a
  // fresh access+refresh pair in the same family. Presenting a token that's
  // already been rotated out is normally a theft signal — the legitimate
  // holder and an attacker holding a stolen copy can't both redeem the same
  // token, so whichever redeems second looks like reuse and kills the whole
  // family, forcing a real re-login rather than silently trusting either
  // side. The one exception is the grace window below, for concurrent
  // *legitimate* redemptions of the same token (two tabs, a retried
  // request) — see user-refresh-tokens.ts.
  async refreshTokens(
    refreshToken: string,
  ): Promise<{ access_token: string; refresh_token: string }> {
    let payload: AuthenticatedUser;
    try {
      payload =
        await this.jwtService.verifyAsync<AuthenticatedUser>(refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (payload.typ !== 'refresh' || !payload.jti) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    // a staff member deactivated mid-session still holds a valid 7-day
    // refresh token — freshClaims re-checks the row here so they can't keep
    // minting access tokens (gated routes already 403 them; this also cuts
    // off the authenticated-but-ungated ones), and recomputes the
    // emailVerified/factor claims rather than carrying the presented
    // token's stale answers forward through every future rotation
    const claims = await this.freshClaims(payload);

    const [record] = await this.db
      .select()
      .from(userRefreshTokensTable)
      .where(eq(userRefreshTokensTable.jti, payload.jti));

    if (!record) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (record.revokedAt) {
      const withinGrace =
        Date.now() - record.revokedAt.getTime() < REFRESH_GRACE_WINDOW_MS;

      if (withinGrace && record.replacedByJti) {
        const [replacement] = await this.db
          .select()
          .from(userRefreshTokensTable)
          .where(eq(userRefreshTokensTable.jti, record.replacedByJti));

        // the replacement is still the live token — replay the same pair
        // instead of rotating again, so a second concurrent request for
        // this same already-rotated token doesn't cause a second,
        // unnecessary rotation (or worse, get mistaken for reuse)
        if (replacement && !replacement.revokedAt) {
          return {
            access_token: await this.createAccessToken(claims),
            refresh_token: await this.signRefreshToken(claims, replacement.jti),
          };
        }
      }

      // outside the grace window, or the replacement itself has since
      // moved on (more than one rotation stale) — real reuse signal
      await this.revokeFamily(record.familyId);
      throw new UnauthorizedException('Invalid or expired token');
    }

    return this.rotateRefreshRecord(record, claims);
  }

  // The row a presented refresh token names, or null if it names none.
  // Deliberately total rather than throwing: both callers (logout,
  // changePassword) treat an invalid/expired/unknown token as "no session to
  // act on" rather than a user-facing failure. It does NOT judge whether the
  // token is still redeemable — a revoked row comes back as itself, and each
  // caller decides what that means (logout doesn't care; changePassword only
  // rotates a row that's still live).
  private async refreshRecordFor(refreshToken: string) {
    let payload: AuthenticatedUser;
    try {
      payload =
        await this.jwtService.verifyAsync<AuthenticatedUser>(refreshToken);
    } catch {
      return null;
    }

    if (payload.typ !== 'refresh' || !payload.jti) {
      return null;
    }

    const [record] = await this.db
      .select()
      .from(userRefreshTokensTable)
      .where(eq(userRefreshTokensTable.jti, payload.jti));

    return record ?? null;
  }

  // Best-effort: an already-invalid/expired/unknown token is treated as a
  // no-op success, not an error — logging out with a stale token shouldn't
  // be a user-facing failure, since the end state ("this session is dead")
  // is the same either way.
  async logout(refreshToken: string): Promise<void> {
    const record = await this.refreshRecordFor(refreshToken);
    if (!record) {
      return;
    }

    await this.revokeFamily(record.familyId);
  }
}
