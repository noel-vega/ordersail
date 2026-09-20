import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {
  AuthenticatedOnly,
  CurrentUser,
  Public,
  SkipMfaEnrollment,
  type AuthenticatedUser,
  NoMfaFactorRequired,
} from 'src/shared/auth/decorators';
import { PasskeysService } from './passkeys.service';
import { PasskeyDto } from './dto/passkey.dto';
import { PasskeyRegisterVerifyDto } from './dto/passkey-register-verify.dto';
import { PasskeyRegisteredDto } from './dto/passkey-registered.dto';
import { PasskeyRemoveDto } from './dto/passkey-remove.dto';
import { PasskeyRenameDto } from './dto/passkey-rename.dto';
import {
  PasskeyChallengeOptionsDto,
  PasskeyChallengeVerifyDto,
} from './dto/passkey-challenge.dto';
import { PasskeySignInVerifyDto } from './dto/passkey-signin.dto';
import { AccessTokenDto } from './dto/access-token.dto';
import { readSessionCookie, respondWithSession } from './session-cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';

// A separate controller rather than more routes on the 391-line
// auth.controller.ts — route-guard-coverage.spec.ts filesystem-scans for
// *.controller.ts, so this is picked up automatically.
//
// Every route here carries @SkipMfaEnrollment() for the same reason
// mfa/enroll does: a caller gated into forced enrollment has to be able to
// reach these in order to satisfy the gate. None carries
// @SkipEmailVerification() — getRegistrationOptions refuses an unverified
// address anyway, and the gate is the right default for the rest.
@Controller('auth/passkeys')
@NoMfaFactorRequired()
export class PasskeysController {
  constructor(private readonly passkeysService: PasskeysService) {}

  // No body: there is no user to name yet. The options come back with an
  // empty allowCredentials, which is what makes the credential discoverable
  // — the authenticator picks one and tells us which.
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('signin/options')
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  async signInOptions(): Promise<Record<string, unknown>> {
    const options = await this.passkeysService.getSignInOptions();
    return options as unknown as Record<string, unknown>;
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('signin/verify')
  @ApiOkResponse({ type: AccessTokenDto })
  @ApiUnauthorizedResponse()
  async signInVerify(
    @Body() dto: PasskeySignInVerifyDto,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<AccessTokenDto> {
    // the same ending as every other sign-in: the service started the
    // Session, the refresh token goes in the cookie (session-cookie.ts)
    return respondWithSession(
      res,
      await this.passkeysService.verifySignIn(
        dto.response as unknown as AuthenticationResponseJSON,
      ),
    );
  }

  // Both challenge routes are @Public() for the same reason /auth/mfa/verify
  // is: the caller has no session yet — that's the entire point of the
  // challenge — and the challenge token is short-lived and scoped to one
  // user.
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('challenge/options')
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  @ApiUnauthorizedResponse()
  async challengeOptions(
    @Body() dto: PasskeyChallengeOptionsDto,
  ): Promise<Record<string, unknown>> {
    const options =
      await this.passkeysService.getChallengeAuthenticationOptions(
        dto.challengeToken,
      );
    return options as unknown as Record<string, unknown>;
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('challenge/verify')
  @ApiOkResponse({ type: AccessTokenDto })
  @ApiUnauthorizedResponse()
  async challengeVerify(
    @Body() dto: PasskeyChallengeVerifyDto,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<AccessTokenDto> {
    return respondWithSession(
      res,
      await this.passkeysService.verifyChallengeAssertion(
        dto.challengeToken,
        dto.response as unknown as AuthenticationResponseJSON,
      ),
    );
  }

  @AuthenticatedOnly()
  @SkipMfaEnrollment()
  @Get()
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: [PasskeyDto] })
  async list(@CurrentUser() user: AuthenticatedUser): Promise<PasskeyDto[]> {
    return this.passkeysService.list(user.sub);
  }

  @AuthenticatedOnly()
  @SkipMfaEnrollment()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register/options')
  @ApiBearerAuth('JWT-auth')
  // PublicKeyCredentialCreationOptionsJSON is deeply polymorphic and
  // @nestjs/swagger can't model it — see PasskeyRegisterVerifyDto.response
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  @ApiForbiddenResponse()
  async registerOptions(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Record<string, unknown>> {
    const options = await this.passkeysService.getRegistrationOptions(user.sub);
    return options as unknown as Record<string, unknown>;
  }

  @AuthenticatedOnly()
  @SkipMfaEnrollment()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register/verify')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: PasskeyRegisteredDto })
  @ApiUnauthorizedResponse()
  @ApiConflictResponse()
  async registerVerify(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PasskeyRegisterVerifyDto,
  ): Promise<PasskeyRegisteredDto> {
    return this.passkeysService.verifyRegistration(
      user.sub,
      dto.response as unknown as RegistrationResponseJSON,
      dto.nickname,
    );
  }

  @AuthenticatedOnly()
  @SkipMfaEnrollment()
  @Patch(':id')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: PasskeyDto })
  async rename(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PasskeyRenameDto,
  ): Promise<PasskeyDto> {
    return this.passkeysService.rename(user.sub, id, dto.nickname);
  }

  // POST rather than DELETE: removal takes a password in the body, and
  // bodies on DELETE are legal but flaky through proxies. Matches the
  // existing precedent at pos-devices.controller.ts's :id/revoke.
  //
  // Ends like auth/mfa/disable and me/change-password: removing a Factor
  // revokes the User's other Sessions and rotates this browser's, so the
  // cookie is read in, its replacement written back out, and the re-minted
  // access token returned (OS-554).
  @AuthenticatedOnly()
  @SkipMfaEnrollment()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post(':id/remove')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: AccessTokenDto })
  @ApiUnauthorizedResponse()
  @ApiConflictResponse()
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PasskeyRemoveDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<AccessTokenDto> {
    return respondWithSession(
      res,
      await this.passkeysService.remove(
        user.sub,
        id,
        dto.password,
        readSessionCookie(req),
      ),
    );
  }
}
