import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
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
import {
  accountApiKeysTable,
  accountsTable,
  and,
  type db as Db,
  eq,
  isNull,
  isUniqueViolation,
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

// a just-rotated-out refresh token, re-presented within this window, replays
// the same replacement pair instead of revoking the family — see
// packages/db/src/schema/user-refresh-tokens.ts for why this exists
const REFRESH_GRACE_WINDOW_MS = 10_000;

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
      permissions: [...permissions].sort(),
    };
  }

  async signin(signinDto: SignInDto) {
    const user = await this.usersService.getByEmail(signinDto.email);

    // staff created from the dashboard have no password until they join via
    // an invite link — treat that the same as a wrong password, not a crash
    if (!user || !user.password) {
      throw new UnauthorizedException();
    }

    if (!(await bcrypt.compare(signinDto.password, user.password))) {
      throw new UnauthorizedException();
    }

    const access_token = await this.createAccessToken(
      user.id,
      user.email,
      user.accountId,
      user.firstname,
      user.lastname,
    );

    return {
      userId: user.id,
      email: user.email,
      accountId: user.accountId,
      firstName: user.firstname,
      lastName: user.lastname,
      access_token,
    };
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

      const access_token = await this.createAccessToken(
        user.id,
        user.email,
        user.accountId,
        user.firstname,
        user.lastname,
      );

      return {
        userId: user.id,
        email: user.email,
        accountId: user.accountId,
        firstName: user.firstname,
        lastName: user.lastname,
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

    const access_token = await this.createAccessToken(
      user.id,
      user.email,
      user.accountId,
      user.firstName,
      user.lastName,
    );

    return {
      userId: user.id,
      email: user.email,
      accountId: user.accountId,
      firstName: user.firstName,
      lastName: user.lastName,
      access_token,
    };
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
  ) {
    return await this.sign(
      { sub, email, accountId, firstName, lastName, typ: 'access' },
      '8h',
    );
  }

  private async signRefreshToken(
    sub: number,
    email: string,
    accountId: number,
    firstName: string,
    lastName: string,
    jti: string,
  ) {
    return await this.sign(
      { sub, email, accountId, firstName, lastName, typ: 'refresh', jti },
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
    familyId: string,
  ): Promise<string> {
    const { token } = await this.mintRefreshToken(
      sub,
      email,
      accountId,
      firstName,
      lastName,
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
    // authenticated-but-ungated ones)
    const [userRow] = await this.db
      .select({ deactivatedAt: usersTable.deactivatedAt })
      .from(usersTable)
      .where(eq(usersTable.id, payload.sub));
    if (!userRow || userRow.deactivatedAt) {
      throw new UnauthorizedException('Invalid or expired token');
    }

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
            ),
            refresh_token: await this.signRefreshToken(
              payload.sub,
              payload.email,
              payload.accountId,
              payload.firstName,
              payload.lastName,
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
