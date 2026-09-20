import {
  Controller,
  Get,
  NotFoundException,
  Patch,
  Post,
  Body,
  Res,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { SessionsService } from './sessions.service';
import {
  clearSessionCookie,
  readSessionCookie,
  respondWithSession,
} from './session-cookie';
import { SignInDto } from './dto/signin.dto';
import { SignUpDto } from './dto/signup.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { AccessTokenDto } from './dto/access-token.dto';
import { MfaChallengeDto } from './dto/mfa-challenge.dto';
import { MfaConfirmDto } from './dto/mfa-confirm.dto';
import { MfaVerifyDto } from './dto/mfa-verify.dto';
import { MfaDisableDto } from './dto/mfa-disable.dto';
import { MfaEnrollResponseDto } from './dto/mfa-enroll-response.dto';
import { MfaRecoveryCodesDto } from './dto/mfa-recovery-codes.dto';
import { MfaRegenerateRecoveryCodesDto } from './dto/mfa-regenerate-recovery-codes.dto';
import { MfaConfirmResponseDto } from './dto/mfa-confirm-response.dto';
import { AuthMe } from './entities/auth-me.entity';
import { UsersService } from '../users/users.service';
import { UpdateUserProfileDto } from '../users/dto/update-user-profile.dto';
import { UserProfile } from '../users/entities/user-profile.entity';
import {
  AuthenticatedOnly,
  CurrentUser,
  Public,
  SkipEmailVerification,
  SkipMfaEnrollment,
  type AuthenticatedUser,
  NoMfaFactorRequired,
} from 'src/shared/auth/decorators';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiUnauthorizedResponse,
  getSchemaPath,
} from '@nestjs/swagger';

// Every handler that ends with a Session — a sign-in, a refresh, a rotation
// — is handed a token pair by the service it called and finishes with
// respondWithSession(), which writes the refresh cookie and returns the
// access-token body. Nothing here starts a Session, assembles a claim or
// names the cookie; see session-cookie.ts and SessionsService.
@Controller('auth')
@NoMfaFactorRequired()
export class AuthController {
  // UsersService, not a third service of its own: the Profile routes below
  // are a second door onto the same rows UsersController already writes, and
  // AuthModule already imports UsersModule for the sign-in path.
  constructor(
    private readonly authService: AuthService,
    private readonly sessionsService: SessionsService,
    private readonly usersService: UsersService,
  ) {}

  @Public()
  // brute-force/credential-stuffing protection — tighter than the 100/min
  // global default
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('signin')
  // returns one of two shapes depending on whether the account has a
  // confirmed MFA factor (OS-316) — both must be declared or a generated
  // client (merchant-sdk) can't type the MFA-challenge branch
  @ApiExtraModels(AccessTokenDto, MfaChallengeDto)
  @ApiOkResponse({
    schema: {
      oneOf: [
        { $ref: getSchemaPath(AccessTokenDto) },
        { $ref: getSchemaPath(MfaChallengeDto) },
      ],
    },
  })
  @ApiUnauthorizedResponse()
  async signin(
    @Body() signinDto: SignInDto,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<AccessTokenDto | MfaChallengeDto> {
    const result = await this.authService.signin(signinDto);

    if (result.mfaRequired) {
      return {
        mfaRequired: true,
        challengeToken: result.challengeToken,
        methods: result.methods,
      };
    }

    return respondWithSession(res, result);
  }

  // exchanges a signin()-issued MFA challenge for real tokens — public
  // because the caller isn't holding a session yet (that's the whole point
  // of the challenge), but the challenge token itself is short-lived and
  // scoped to exactly one user
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('mfa/verify')
  @ApiOkResponse({ type: AccessTokenDto })
  @ApiUnauthorizedResponse()
  async verifyMfaChallenge(
    @Body() dto: MfaVerifyDto,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<AccessTokenDto> {
    return respondWithSession(
      res,
      await this.authService.verifyMfaChallenge(dto.challengeToken, dto.code),
    );
  }

  // exempt from MfaEnrollmentGuard — a caller gated into forced enrollment
  // (OS-473) has to be able to reach these in order to satisfy it
  @AuthenticatedOnly()
  @SkipMfaEnrollment()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('mfa/enroll')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: MfaEnrollResponseDto })
  async enrollMfa(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MfaEnrollResponseDto> {
    return this.authService.enrollMfa(user.sub);
  }

  @AuthenticatedOnly()
  @SkipMfaEnrollment()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('mfa/confirm')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: MfaConfirmResponseDto })
  @ApiUnauthorizedResponse()
  async confirmMfa(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MfaConfirmDto,
  ): Promise<MfaConfirmResponseDto> {
    // comes back with a re-minted access token as well as the codes — see
    // AuthService.confirmMfa. The refresh cookie is untouched.
    return this.authService.confirmMfa(user.sub, dto.code, dto.password);
  }

  @AuthenticatedOnly()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('mfa/disable')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse()
  @ApiUnauthorizedResponse()
  @ApiConflictResponse()
  async disableMfa(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MfaDisableDto,
  ): Promise<void> {
    await this.authService.disableMfa(user.sub, dto.password);
  }

  @AuthenticatedOnly()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('mfa/recovery-codes/regenerate')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: MfaRecoveryCodesDto })
  @ApiUnauthorizedResponse()
  async regenerateRecoveryCodes(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MfaRegenerateRecoveryCodesDto,
  ): Promise<MfaRecoveryCodesDto> {
    return this.authService.regenerateRecoveryCodes(user.sub, dto.password);
  }

  @Public()
  // limits automated account-creation spam
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('signup')
  @ApiOkResponse({ type: AccessTokenDto })
  @ApiConflictResponse()
  async signup(
    @Body() signupDto: SignUpDto,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<AccessTokenDto> {
    return respondWithSession(res, await this.authService.signup(signupDto));
  }

  @Public()
  // invite tokens are 32 bytes and single-use, but keep guessing attempts bounded
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('accept-invite')
  @ApiOkResponse({ type: AccessTokenDto })
  @ApiUnauthorizedResponse()
  async acceptInvite(
    @Body() acceptInviteDto: AcceptInviteDto,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<AccessTokenDto> {
    return respondWithSession(
      res,
      await this.authService.acceptInvite(acceptInviteDto),
    );
  }

  @Public()
  // strict — coordinate with the merchant-api throttler (OS-314). Response
  // shape never reveals whether the email matched an account.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('forgot-password')
  @ApiOkResponse()
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<void> {
    await this.authService.requestPasswordReset(dto.email);
  }

  @Public()
  // reset tokens are 32 bytes and single-use, but keep guessing attempts
  // bounded — mirrors accept-invite's rate limit
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('reset-password')
  @ApiOkResponse()
  @ApiUnauthorizedResponse()
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.authService.resetPassword(dto.token, dto.password);
  }

  // requires the caller's existing session — the emailed token proves inbox
  // control, not identity, so it never creates a session (see
  // AuthService.verifyEmail). Exempt from both gates: a caller here is
  // unverified by definition, and may also be MFA-gated. Returns a re-minted
  // access token carrying emailVerified: true (same idea as mfa/confirm);
  // the refresh cookie is untouched — it carries no claims to go stale.
  @AuthenticatedOnly()
  @SkipEmailVerification()
  @SkipMfaEnrollment()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('verify-email')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: AccessTokenDto })
  @ApiBadRequestResponse({ description: 'Invalid or expired token' })
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse({ description: 'Token belongs to a different account' })
  async verifyEmail(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: VerifyEmailDto,
  ): Promise<AccessTokenDto> {
    return this.authService.verifyEmail(user.sub, dto.token);
  }

  // exempt from EmailVerifiedGuard (an unverified caller has to be able to
  // reach this in order to get verified) but still requires a real session
  // — resends to the caller's own account, not an arbitrary email, so
  // there's no new enumeration surface the way forgot-password has to
  // guard against. Also exempt from MfaEnrollmentGuard: enrollMfa() requires
  // a verified email, so an unverified user on an MFA-required account
  // would otherwise be unable to satisfy either gate
  @AuthenticatedOnly()
  @SkipEmailVerification()
  @SkipMfaEnrollment()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('verify-email/resend')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse()
  @ApiUnauthorizedResponse()
  async resendVerification(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.authService.resendVerification(user.sub);
  }

  // any authenticated user reads their own identity + effective permission
  // keys (merchant-web's permission context). Exempt from
  // EmailVerifiedGuard/MfaEnrollmentGuard — a gated caller needs this to
  // know it's gated in the first place (merchant-web reads
  // emailVerified/mfaEnrollmentSatisfied from here).
  @AuthenticatedOnly()
  @SkipEmailVerification()
  @SkipMfaEnrollment()
  @Get('me')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: AuthMe })
  @ApiUnauthorizedResponse()
  me(@CurrentUser() user: AuthenticatedUser): Promise<AuthMe> {
    return this.authService.me(user);
  }

  // The caller's own Profile — the self-editable half of their users row
  // (ADR 0001). Its administrative counterpart is GET/PATCH /users/:id,
  // behind users:read / users:write; these two carry no permission key at
  // all, and can't: a user may hold no roles whatsoever, so "can I manage
  // myself" must never be something an Owner has to grant. That's safe
  // because both routes address user.sub — there is no id in the path for a
  // caller to point at someone else's row.
  //
  // Deliberately NOT folded into GET /auth/me above. That response is cached
  // with a 60s staleTime and cleared on every auth mutation, which is the
  // wrong lifecycle for a form the user edits; the passkey list stayed out
  // of it for the same reason (OS-485).
  //
  // No @SkipEmailVerification()/@SkipMfaEnrollment(): unlike /auth/me and
  // the MFA routes, nothing here helps a gated caller satisfy their gate, so
  // the default — blocked until verified and enrolled — is right.
  @AuthenticatedOnly()
  @Get('me/profile')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: UserProfile })
  @ApiUnauthorizedResponse()
  async profile(@CurrentUser() user: AuthenticatedUser): Promise<UserProfile> {
    const profile = await this.usersService.getProfile(
      user.sub,
      user.accountId,
    );
    // an access token outlives the row it was minted from by up to 8h, so a
    // deleted user (a revoked invite, say) can still reach this
    if (!profile) throw new NotFoundException();
    return profile;
  }

  // Reuses UpdateUserProfileDto rather than declaring a parallel shape: the
  // fields a person may change about themselves are exactly the fields an
  // administrator may change about them, and only the gate differs.
  @AuthenticatedOnly()
  @Patch('me/profile')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: UserProfile })
  @ApiUnauthorizedResponse()
  async updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateUserProfileDto,
  ): Promise<UserProfile> {
    const updated = await this.usersService.updateProfile(
      user.sub,
      user.accountId,
      dto,
    );
    if (!updated) throw new NotFoundException();
    return updated;
  }

  // Under /auth/me because it can only ever touch the caller's own row —
  // there's no user id to pass and so no way to aim it at anyone else. The
  // signed-in counterpart to POST /auth/reset-password, which is for
  // someone who can't sign in at all.
  //
  // Deliberately carries no @RequireMfaFactor, unlike the money and access
  // actions gated that way (OS-492): it would lock out exactly the
  // password-only users this exists for, who by definition hold no factor.
  // The current password is the re-authentication, the same bar mfa/disable
  // and passkey removal already apply.
  //
  // Every live refresh token for this user dies here, this browser's
  // included — so the cookie is read in and a rotated replacement written
  // back out, exactly as token/refresh does, and the re-minted access token
  // is returned. Without that the caller would be signed out of the browser
  // they just used to change their own password.
  @AuthenticatedOnly()
  // mirrors mfa/disable — this one also guesses at the current password, so
  // it gets the same tight bucket rather than the looser credential-entry one
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('me/change-password')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: AccessTokenDto })
  @ApiUnauthorizedResponse()
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<AccessTokenDto> {
    return respondWithSession(
      res,
      await this.authService.changePassword(
        user.sub,
        dto.currentPassword,
        dto.newPassword,
        readSessionCookie(req),
      ),
    );
  }

  // Under /auth/me for the same reason change-password is: there is no user
  // id to pass, so it can only ever address the caller's own sessions.
  //
  // No body and no password. Every other credential action on the Security
  // tab re-authenticates because it *weakens* the account; this one only
  // takes access away, so demanding a password would buy nothing and would
  // exclude a passkey-only user who may not have one to type.
  //
  // `revoke-others`, not `revoke-all`: sparing the caller's own family is the
  // whole point, so the path says so rather than promising something the
  // handler deliberately doesn't do.
  //
  // The refresh cookie names the family to spare, and nothing is written
  // back — unlike change-password, this doesn't rotate, so the cookie in the
  // browser stays valid as-is and there's no token to return. With no usable
  // cookie the service refuses (409) and revokes nothing, rather than guess
  // which session is "this one" or mint one from a bare access token — see
  // SessionsService.revokeOtherSessions. Every other browser dies at its next
  // refresh, and within at most one access-token lifetime (8h) even one that
  // never refreshes.
  @AuthenticatedOnly()
  @Post('me/sessions/revoke-others')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse()
  @ApiUnauthorizedResponse()
  @ApiConflictResponse()
  async revokeOtherSessions(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: FastifyRequest,
  ): Promise<void> {
    await this.sessionsService.revokeOtherSessions(
      user.sub,
      readSessionCookie(req),
    );
  }

  @Public()
  @Post('logout')
  @ApiOkResponse()
  async logout(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<void> {
    const refreshToken = readSessionCookie(req);
    if (refreshToken) {
      await this.sessionsService.logout(refreshToken);
    }
    clearSessionCookie(res);
  }

  @Public()
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: AccessTokenDto })
  @ApiUnauthorizedResponse()
  @Post('token/refresh')
  async refreshToken(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<AccessTokenDto> {
    const refreshToken = readSessionCookie(req);
    if (!refreshToken) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    return respondWithSession(
      res,
      await this.sessionsService.refreshTokens(refreshToken),
    );
  }
}
