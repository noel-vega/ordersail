import {
  Controller,
  Get,
  Post,
  Body,
  Res,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
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

  @Public()
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
    );

    res.setCookie(REFRESH_TOKEN_COOKIE, refreshToken, {
      httpOnly: true, // Prevents client-side JS from accessing the cookie
      // secure: true, // Required for HTTPS environments
      sameSite: 'lax', // Helps protect against CSRF attacks
      path: '/', // Scopes the cookie to the entire domain
      maxAge: 60 * 60 * 24 * 7, // 7 days
    });

    return { access_token: result.access_token };
  }

  @Public()
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
    );

    res.setCookie(REFRESH_TOKEN_COOKIE, refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    });

    return { access_token: result.access_token };
  }

  @Public()
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
    );

    res.setCookie(REFRESH_TOKEN_COOKIE, refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    });

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
  logout(@Res({ passthrough: true }) res: FastifyReply): void {
    // refresh_token is httpOnly, so it can only be cleared by the server —
    // the client can't just delete it itself
    res.clearCookie(REFRESH_TOKEN_COOKIE, { path: '/' });
  }

  @Public()
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: AccessTokenDto })
  @ApiUnauthorizedResponse()
  @Get('token/refresh')
  async refreshToken(@Req() req: FastifyRequest): Promise<AccessTokenDto> {
    const refreshToken = req.cookies[REFRESH_TOKEN_COOKIE];
    if (!refreshToken) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const access_token =
      await this.authService.refreshAccessToken(refreshToken);
    return { access_token };
  }
}
