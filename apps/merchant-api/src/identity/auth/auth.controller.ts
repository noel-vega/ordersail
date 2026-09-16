import { randomUUID } from 'node:crypto';
import {
  Controller,
  Get,
  Post,
  Body,
  Res,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { SignInDto } from './dto/signin.dto';
import { SignUpDto } from './dto/signup.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
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
import {
  AuthenticatedOnly,
  CurrentUser,
  Public,
  SkipEmailVerification,
  SkipMfaEnrollment,
  type AuthenticatedUser,
} from 'src/shared/auth/decorators';
import { env } from 'src/shared/env';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiUnauthorizedResponse,
  getSchemaPath,
} from '@nestjs/swagger';

const REFRESH_TOKEN_COOKIE = 'refresh_token';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

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
      return { mfaRequired: true, challengeToken: result.challengeToken };
    }

    const refreshToken = await this.authService.createRefreshToken(
      result.userId,
      result.email,
      result.accountId,
      result.firstName,
      result.lastName,
      result.emailVerified,
      result.mfaEnrollmentSatisfied,
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
      result.userId,
      result.email,
      result.accountId,
      result.firstName,
      result.lastName,
      result.emailVerified,
      result.mfaEnrollmentSatisfied,
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
    const access_token = await this.authService.createAccessToken(
      user.sub,
      user.email,
      user.accountId,
      user.firstName,
      user.lastName,
      user.emailVerified,
      true,
    );

    return { recoveryCodes: result.recoveryCodes, access_token };
  }

  @AuthenticatedOnly()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('mfa/disable')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse()
  @ApiUnauthorizedResponse()
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
      result.userId,
      result.email,
      result.accountId,
      result.firstName,
      result.lastName,
      result.emailVerified,
      result.mfaEnrollmentSatisfied,
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
      result.userId,
      result.email,
      result.accountId,
      result.firstName,
      result.lastName,
      result.emailVerified,
      result.mfaEnrollmentSatisfied,
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

  // reachable while unverified — clicking the emailed link works even in a
  // browser/tab with no session at all (or a different device than the one
  // that signed up), and returns a fresh, correctly-claimed token pair
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('verify-email')
  @ApiOkResponse({ type: AccessTokenDto })
  @ApiUnauthorizedResponse()
  async verifyEmail(
    @Body() dto: VerifyEmailDto,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<AccessTokenDto> {
    const result = await this.authService.verifyEmail(dto.token);

    const refreshToken = await this.authService.createRefreshToken(
      result.userId,
      result.email,
      result.accountId,
      result.firstName,
      result.lastName,
      result.emailVerified,
      result.mfaEnrollmentSatisfied,
      randomUUID(),
    );

    this.setRefreshCookie(res, refreshToken);

    return { access_token: result.access_token };
  }

  // exempt from EmailVerifiedGuard (an unverified caller has to be able to
  // reach this in order to get verified) but still requires a real session
  // — resends to the caller's own account, not an arbitrary email, so
  // there's no new enumeration surface the way forgot-password has to
  // guard against
  @AuthenticatedOnly()
  @SkipEmailVerification()
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
