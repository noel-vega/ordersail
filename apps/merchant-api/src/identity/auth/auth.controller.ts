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
import { AccessTokenDto } from './dto/access-token.dto';
import { AuthMe } from './entities/auth-me.entity';
import {
  CurrentUser,
  Public,
  type AuthenticatedUser,
} from 'src/shared/auth/decorators';
import { env } from 'src/shared/env';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOkResponse,
  ApiUnauthorizedResponse,
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
  @ApiOkResponse({ type: AccessTokenDto })
  @ApiUnauthorizedResponse()
  async signin(
    @Body() signinDto: SignInDto,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<AccessTokenDto> {
    const result = await this.authService.signin(signinDto);

    const refreshToken = await this.authService.createRefreshToken(
      result.userId,
      result.email,
      result.accountId,
      result.firstName,
      result.lastName,
      randomUUID(),
    );

    this.setRefreshCookie(res, refreshToken);

    return { access_token: result.access_token };
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
      randomUUID(),
    );

    this.setRefreshCookie(res, refreshToken);

    return { access_token: result.access_token };
  }

  // no @RequirePermissions — any authenticated user reads their own identity
  // + effective permission keys (merchant-web's permission context)
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
