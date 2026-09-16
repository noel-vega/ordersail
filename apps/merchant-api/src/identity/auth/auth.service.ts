import { randomUUID } from 'node:crypto';
import {
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
import { AuthMe } from './entities/auth-me.entity';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { EmailService } from 'src/shared/email/email.service';
import { env } from 'src/shared/env';
import { generateToken } from 'src/shared/common/generate-token.util';
import { decryptMfaSecret, encryptMfaSecret } from 'src/shared/mfa/mfa-crypto';
import { generateRecoveryCodes } from 'src/shared/mfa/recovery-codes.util';
import {
  accountApiKeysTable,
  accountsTable,
  and,
  type db as Db,
  eq,
  isNull,
  isUniqueViolation,
  userEmailVerificationsTable,
  userMfaRecoveryCodesTable,
  userMfaTable,
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

interface SignInSuccessResult {
  mfaRequired: false;
  userId: number;
  email: string;
  accountId: number;
  firstName: string;
  lastName: string;
  emailVerified: boolean;
  access_token: string;
}

interface MfaChallengeResult {
  mfaRequired: true;
  challengeToken: string;
}

type SignInResult = SignInSuccessResult | MfaChallengeResult;

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
    return {
      userId: user.sub,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      accountId: user.accountId,
      emailVerified: user.emailVerified,
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

    // a confirmed second factor means the password alone isn't enough —
    // withhold tokens and hand back a short-lived challenge instead. An
    // *unconfirmed* enrollment (mid-setup, never finished) doesn't count:
    // there's nothing to challenge with yet.
    const [mfa] = await this.db
      .select({ confirmedAt: userMfaTable.confirmedAt })
      .from(userMfaTable)
      .where(eq(userMfaTable.userId, user.id));

    if (mfa?.confirmedAt) {
      return {
        mfaRequired: true,
        challengeToken: await this.createMfaChallengeToken(user.id),
      };
    }

    return this.buildSignInSuccess(user);
  }

  private async buildSignInSuccess(user: {
    id: number;
    email: string;
    accountId: number;
    firstname: string;
    lastname: string;
    emailVerifiedAt: Date | null;
  }): Promise<SignInSuccessResult> {
    const emailVerified = user.emailVerifiedAt !== null;
    const access_token = await this.createAccessToken(
      user.id,
      user.email,
      user.accountId,
      user.firstname,
      user.lastname,
      emailVerified,
    );

    return {
      mfaRequired: false,
      userId: user.id,
      email: user.email,
      accountId: user.accountId,
      firstName: user.firstname,
      lastName: user.lastname,
      emailVerified,
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
  async verifyMfaChallenge(
    challengeToken: string,
    code: string,
  ): Promise<SignInSuccessResult> {
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

    const [mfa] = await this.db
      .select()
      .from(userMfaTable)
      .where(eq(userMfaTable.userId, user.id));
    if (!mfa?.confirmedAt) {
      throw new UnauthorizedException('Invalid or expired challenge');
    }

    const isValidTotp = authenticator.verify({
      token: code,
      secret: decryptMfaSecret(mfa.secret),
    });
    const isValidRecoveryCode =
      !isValidTotp && (await this.consumeRecoveryCode(user.id, code));

    if (!isValidTotp && !isValidRecoveryCode) {
      throw new UnauthorizedException('Invalid code');
    }

    return this.buildSignInSuccess(user);
  }

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
        await this.db
          .update(userMfaRecoveryCodesTable)
          .set({ usedAt: new Date() })
          .where(eq(userMfaRecoveryCodesTable.id, row.id));
        return true;
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

  // Verifies the first code against the pending secret, activates it, and
  // issues the one and only batch of recovery codes for this enrollment —
  // the caller must save them now, they're never shown again.
  async confirmMfa(
    userId: number,
    code: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const [mfa] = await this.db
      .select()
      .from(userMfaTable)
      .where(eq(userMfaTable.userId, userId));
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

    await this.db
      .update(userMfaTable)
      .set({ confirmedAt: new Date(), updatedAt: new Date() })
      .where(eq(userMfaTable.id, mfa.id));

    return { recoveryCodes: await this.issueRecoveryCodes(userId) };
  }

  // Requires current-password re-entry — standard practice for removing a
  // second factor, since the whole point of MFA is that a password alone
  // shouldn't be enough to weaken an account's security.
  async disableMfa(userId: number, password: string): Promise<void> {
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

    await this.db
      .delete(userMfaRecoveryCodesTable)
      .where(eq(userMfaRecoveryCodesTable.userId, userId));
    await this.db.delete(userMfaTable).where(eq(userMfaTable.userId, userId));
  }

  async regenerateRecoveryCodes(
    userId: number,
  ): Promise<{ recoveryCodes: string[] }> {
    const [mfa] = await this.db
      .select({ confirmedAt: userMfaTable.confirmedAt })
      .from(userMfaTable)
      .where(eq(userMfaTable.userId, userId));
    if (!mfa?.confirmedAt) {
      throw new UnauthorizedException('MFA is not enabled');
    }

    return { recoveryCodes: await this.issueRecoveryCodes(userId) };
  }

  private async issueRecoveryCodes(userId: number): Promise<string[]> {
    const codes = generateRecoveryCodes();

    await this.db
      .delete(userMfaRecoveryCodesTable)
      .where(eq(userMfaRecoveryCodesTable.userId, userId));
    await this.db.insert(userMfaRecoveryCodesTable).values(
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

      const access_token = await this.createAccessToken(
        user.id,
        user.email,
        user.accountId,
        user.firstname,
        user.lastname,
        false,
      );

      return {
        userId: user.id,
        email: user.email,
        accountId: user.accountId,
        firstName: user.firstname,
        lastName: user.lastname,
        emailVerified: false,
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
    const access_token = await this.createAccessToken(
      user.id,
      user.email,
      user.accountId,
      user.firstName,
      user.lastName,
      true,
    );

    return {
      userId: user.id,
      email: user.email,
      accountId: user.accountId,
      firstName: user.firstName,
      lastName: user.lastName,
      emailVerified: true,
      access_token,
    };
  }

  // Verifies the emailed token, marks the account verified, and — since
  // clicking the link proves control of the address — mints a fresh
  // access+refresh pair with emailVerified: true, auto-logging in whichever
  // browser/tab opens the link (even if it's not the original session). This
  // bypasses the MFA challenge (no password check happens here either), but
  // that's safe: enrollMfa() requires emailVerifiedAt already set, so a user
  // reachable by this method (emailVerifiedAt still null) can never have a
  // confirmed MFA factor yet.
  async verifyEmail(token: string) {
    const [verification] = await this.db
      .select()
      .from(userEmailVerificationsTable)
      .where(eq(userEmailVerificationsTable.token, token));

    if (!verification || verification.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const [user] = await this.db
      .update(usersTable)
      .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(usersTable.id, verification.userId))
      .returning();

    if (!user) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    await this.db
      .delete(userEmailVerificationsTable)
      .where(eq(userEmailVerificationsTable.id, verification.id));

    const access_token = await this.createAccessToken(
      user.id,
      user.email,
      user.accountId,
      user.firstname,
      user.lastname,
      true,
    );

    return {
      userId: user.id,
      email: user.email,
      accountId: user.accountId,
      firstName: user.firstname,
      lastName: user.lastname,
      emailVerified: true,
      access_token,
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
    await this.db
      .insert(userEmailVerificationsTable)
      .values({
        userId: user.id,
        token,
        expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
      })
      .onConflictDoUpdate({
        target: userEmailVerificationsTable.userId,
        set: {
          token,
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
    await this.db
      .insert(userPasswordResetsTable)
      .values({
        userId: user.id,
        token,
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      })
      .onConflictDoUpdate({
        target: userPasswordResetsTable.userId,
        set: { token, expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS) },
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
      .where(eq(userPasswordResetsTable.token, token));

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

  private async revokeAllFamiliesForUser(userId: number): Promise<void> {
    await this.db
      .update(userRefreshTokensTable)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(userRefreshTokensTable.userId, userId),
          isNull(userRefreshTokensTable.revokedAt),
        ),
      );
  }

  private async sign(
    payload: Record<string, unknown>,
    expiresIn: JwtSignOptions['expiresIn'],
  ) {
    return await this.jwtService.signAsync(payload, { expiresIn });
  }

  async createAccessToken(
    sub: number,
    email: string,
    accountId: number,
    firstName: string,
    lastName: string,
    emailVerified: boolean,
  ) {
    return await this.sign(
      {
        sub,
        email,
        accountId,
        firstName,
        lastName,
        emailVerified,
        typ: 'access',
      },
      '8h',
    );
  }

  private async signRefreshToken(
    sub: number,
    email: string,
    accountId: number,
    firstName: string,
    lastName: string,
    emailVerified: boolean,
    jti: string,
  ) {
    return await this.sign(
      {
        sub,
        email,
        accountId,
        firstName,
        lastName,
        emailVerified,
        typ: 'refresh',
        jti,
      },
      '7d',
    );
  }

  // Allocates a fresh jti, records it against `familyId`, and signs a token
  // for it. `familyId` is fresh (randomUUID()) for a brand-new session
  // (signin/signup/accept-invite, see AuthController) and carried through
  // unchanged on every rotation (refreshTokens) — it's the unit reuse
  // detection revokes as a whole.
  private async mintRefreshToken(
    sub: number,
    email: string,
    accountId: number,
    firstName: string,
    lastName: string,
    emailVerified: boolean,
    familyId: string,
  ): Promise<{ token: string; jti: string }> {
    const jti = randomUUID();
    await this.db
      .insert(userRefreshTokensTable)
      .values({ userId: sub, jti, familyId });
    const token = await this.signRefreshToken(
      sub,
      email,
      accountId,
      firstName,
      lastName,
      emailVerified,
      jti,
    );
    return { token, jti };
  }

  async createRefreshToken(
    sub: number,
    email: string,
    accountId: number,
    firstName: string,
    lastName: string,
    emailVerified: boolean,
    familyId: string,
  ): Promise<string> {
    const { token } = await this.mintRefreshToken(
      sub,
      email,
      accountId,
      firstName,
      lastName,
      emailVerified,
      familyId,
    );
    return token;
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
    // refresh token — re-check the row here so they can't keep minting
    // access tokens (gated routes already 403 them; this also cuts off the
    // authenticated-but-ungated ones). emailVerifiedAt is re-checked here
    // too, for the same reason — trusting payload.emailVerified would carry
    // a stale claim forward through every future rotation instead of
    // picking up a verification that happened after this refresh token was
    // minted.
    const [userRow] = await this.db
      .select({
        deactivatedAt: usersTable.deactivatedAt,
        emailVerifiedAt: usersTable.emailVerifiedAt,
      })
      .from(usersTable)
      .where(eq(usersTable.id, payload.sub));
    if (!userRow || userRow.deactivatedAt) {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const emailVerified = userRow.emailVerifiedAt !== null;

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
            access_token: await this.createAccessToken(
              payload.sub,
              payload.email,
              payload.accountId,
              payload.firstName,
              payload.lastName,
              emailVerified,
            ),
            refresh_token: await this.signRefreshToken(
              payload.sub,
              payload.email,
              payload.accountId,
              payload.firstName,
              payload.lastName,
              emailVerified,
              replacement.jti,
            ),
          };
        }
      }

      // outside the grace window, or the replacement itself has since
      // moved on (more than one rotation stale) — real reuse signal
      await this.revokeFamily(record.familyId);
      throw new UnauthorizedException('Invalid or expired token');
    }

    const { token: refresh_token, jti: nextJti } = await this.mintRefreshToken(
      payload.sub,
      payload.email,
      payload.accountId,
      payload.firstName,
      payload.lastName,
      emailVerified,
      record.familyId,
    );
    await this.db
      .update(userRefreshTokensTable)
      .set({ revokedAt: new Date(), replacedByJti: nextJti })
      .where(eq(userRefreshTokensTable.id, record.id));

    const access_token = await this.createAccessToken(
      payload.sub,
      payload.email,
      payload.accountId,
      payload.firstName,
      payload.lastName,
      emailVerified,
    );

    return { access_token, refresh_token };
  }

  // Best-effort: an already-invalid/expired/unknown token is treated as a
  // no-op success, not an error — logging out with a stale token shouldn't
  // be a user-facing failure, since the end state ("this session is dead")
  // is the same either way.
  async logout(refreshToken: string): Promise<void> {
    let payload: AuthenticatedUser;
    try {
      payload =
        await this.jwtService.verifyAsync<AuthenticatedUser>(refreshToken);
    } catch {
      return;
    }

    if (payload.typ !== 'refresh' || !payload.jti) {
      return;
    }

    const [record] = await this.db
      .select()
      .from(userRefreshTokensTable)
      .where(eq(userRefreshTokensTable.jti, payload.jti));

    if (!record) {
      return;
    }

    await this.revokeFamily(record.familyId);
  }
}
