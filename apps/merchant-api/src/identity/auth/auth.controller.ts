import { randomUUID } from 'node:crypto';
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
import { AuthService, claimsFromSignInResult } from './auth.service';
import { claimsFromUser } from './token-claims';
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
import { env } from 'src/shared/env';
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

const REFRESH_TOKEN_COOKIE = 'refresh_token';

@Controller('auth')
@NoMfaFactorRequired()
export class AuthController {
  // UsersService, not a third service of its own: the Profile routes below
  // are a second door onto the same rows UsersController already writes, and
  // AuthModule already imports UsersModule for the sign-in path.
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  private setRefreshCookie(res: FastifyReply, refreshToken: string): void {
    res.setCookie(REFRESH_TOKEN_COOKIE, refreshToken, {
      httpOnly: true, // Prevents client-side JS from accessing the cookie
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax', // Helps protect against CSRF attacks
      path: '/', // Scopes the cookie to the entire domain
      maxAge: 60 * 60 * 24 * 7, // 7 days
    });
  }

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

    const refreshToken = await this.authService.createRefreshToken(
      claimsFromSignInResult(result),
      randomUUID(),
    );

    this.setRefreshCookie(res, refreshToken);

    return { access_token: result.access_token };
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
    const result = await this.authService.verifyMfaChallenge(
      dto.challengeToken,
      dto.code,
    );

    const refreshToken = await this.authService.createRefreshToken(
      claimsFromSignInResult(result),
      randomUUID(),
    );

    this.setRefreshCookie(res, refreshToken);

    return { access_token: result.access_token };
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
    const result = await this.authService.confirmMfa(
      user.sub,
      dto.code,
      dto.password,
    );

    // this caller may have been gated into forced enrollment
    // (mfaEnrollmentSatisfied: false baked into their current access
    // token) — re-mint immediately with the now-satisfied claim so they
    // aren't stuck until their token naturally refreshes
    const access_token = await this.authService.createAccessToken({
      ...claimsFromUser(user),
      mfaEnrollmentSatisfied: true,
      // they hold one now — passkey registration sets this too, and without
      // it a caller who just enrolled TOTP keeps failing every gated action
      // until their next refresh
      hasMfaFactor: true,
    });

    return { recoveryCodes: result.recoveryCodes, access_token };
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
    const result = await this.authService.signup(signupDto);

    const refreshToken = await this.authService.createRefreshToken(
      claimsFromSignInResult(result),
      randomUUID(),
    );

    this.setRefreshCookie(res, refreshToken);

    return { access_token: result.access_token };
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
    const result = await this.authService.acceptInvite(acceptInviteDto);

    const refreshToken = await this.authService.createRefreshToken(
      claimsFromSignInResult(result),
      randomUUID(),
    );

    this.setRefreshCookie(res, refreshToken);

    return { access_token: result.access_token };
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
  // the refresh cookie is untouched and picks the claim up on next rotation.
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
    const { access_token, refresh_token } =
      await this.authService.changePassword(
        user,
        dto.currentPassword,
        dto.newPassword,
        req.cookies[REFRESH_TOKEN_COOKIE],
      );

    this.setRefreshCookie(res, refresh_token);
    return { access_token };
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
  // AuthService.revokeOtherSessions. Every other browser dies at its next
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
    await this.authService.revokeOtherSessions(
      user.sub,
      req.cookies[REFRESH_TOKEN_COOKIE],
    );
  }

  @Public()
  @Post('logout')
  @ApiOkResponse()
  async logout(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<void> {
    const refreshToken = req.cookies[REFRESH_TOKEN_COOKIE];
    if (refreshToken) {
      await this.authService.logout(refreshToken);
    }
    // refresh_token is httpOnly, so it can only be cleared by the server —
    // the client can't just delete it itself
    res.clearCookie(REFRESH_TOKEN_COOKIE, { path: '/' });
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
    const refreshToken = req.cookies[REFRESH_TOKEN_COOKIE];
    if (!refreshToken) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const { access_token, refresh_token } =
      await this.authService.refreshTokens(refreshToken);
    this.setRefreshCookie(res, refresh_token);
    return { access_token };
  }
}
