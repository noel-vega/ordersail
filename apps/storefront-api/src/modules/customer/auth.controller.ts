import { randomUUID } from 'node:crypto';
import { Controller, Post, Body } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiSecurity,
  ApiUnauthorizedResponse,
  ApiConflictResponse,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { CustomerSignUpDto } from './dto/customer-signup.dto';
import { CustomerSignInDto } from './dto/customer-signin.dto';
import { TokenPairDto } from './dto/token-pair.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { CurrentAccountId } from '../app-key/app-key.decorators';
import { CurrentCartToken } from '../cart/cart.decorators';

// Tokens travel in the request/response body, not a cookie — a storefront
// can be hosted on any merchant-owned domain, and a cookie set by
// storefront-api (sameSite=lax, host-only) never rides along on a genuinely
// cross-site fetch/XHR. @ordersail/storefront-sdk stores both tokens itself
// and attaches the access token as `Authorization: Bearer <token>`.
@ApiSecurity('AppKey-auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('signup')
  @ApiOkResponse({ type: TokenPairDto })
  @ApiConflictResponse()
  async signup(
    @Body() dto: CustomerSignUpDto,
    @CurrentAccountId() accountId: number,
  ): Promise<TokenPairDto> {
    const result = await this.authService.signup(dto, accountId);

    const refresh_token = await this.authService.createRefreshToken(
      result.customerId,
      result.email,
      result.accountId,
      result.firstName,
      result.lastName,
      randomUUID(),
    );

    return { access_token: result.access_token, refresh_token };
  }

  @Post('signin')
  @ApiOkResponse({ type: TokenPairDto })
  @ApiUnauthorizedResponse()
  async signin(
    @Body() dto: CustomerSignInDto,
    @CurrentAccountId() accountId: number,
    @CurrentCartToken() cartToken: string | undefined,
  ): Promise<TokenPairDto> {
    const result = await this.authService.signin(dto, accountId, cartToken);

    const refresh_token = await this.authService.createRefreshToken(
      result.customerId,
      result.email,
      result.accountId,
      result.firstName,
      result.lastName,
      randomUUID(),
    );

    return { access_token: result.access_token, refresh_token };
  }

  @Post('token/refresh')
  @ApiOkResponse({ type: TokenPairDto })
  @ApiUnauthorizedResponse()
  async refreshToken(@Body() dto: RefreshTokenDto): Promise<TokenPairDto> {
    return await this.authService.refreshTokens(dto.refresh_token);
  }

  // Best-effort: an already-invalid/expired/unknown refresh token still
  // returns 200 — see AuthService.logout. The customer's browser forgetting
  // its tokens was always sufficient from their point of view; this just
  // makes it true server-side too.
  @Post('logout')
  @ApiOkResponse()
  async logout(@Body() dto: RefreshTokenDto): Promise<void> {
    await this.authService.logout(dto.refresh_token);
  }
}
