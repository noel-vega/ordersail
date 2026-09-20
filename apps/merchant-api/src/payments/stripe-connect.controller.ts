import { Controller, Get, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOkResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { StripeConnectService } from './stripe-connect.service';
import { StripeConnectStatus } from './entities/stripe-connect-status.entity';
import { AccountSessionResponse } from './entities/account-session.entity';
import { OnboardingLinkResponse } from './entities/onboarding-link.entity';
import {
  CurrentUser,
  NoMfaFactorRequired,
  RequireMfaFactor,
  RequirePermissions,
  type AuthenticatedUser,
} from 'src/shared/auth/decorators';

// merchant-facing Connect routes. The `account.updated` webhook that keeps
// charges_enabled / details_submitted in sync lives in StripeWebhookController
// (the one Stripe webhook endpoint) and calls StripeConnectService directly.
@Controller('stripe-connect')
@NoMfaFactorRequired()
export class StripeConnectController {
  constructor(private readonly stripeConnectService: StripeConnectService) {}

  // Connecting an account — the money action, and the one that needs a
  // second factor. Returns a Stripe-hosted onboarding URL (OS-498) rather
  // than an embedded session, so a refusal here is an ordinary API error the
  // dashboard can show, not something swallowed inside Connect.js.
  @Post('onboarding-link')
  @RequirePermissions('payments:write')
  @RequireMfaFactor()
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: OnboardingLinkResponse })
  createOnboardingLink(@CurrentUser() user: AuthenticatedUser) {
    return this.stripeConnectService.createOnboardingLink(user.accountId);
  }

  // Ungated, deliberately: the embedded management and balance components
  // call this on every Payments page load for a connected merchant, from
  // inside Connect.js's fetchClientSecret — where a 403 is an opaque Stripe
  // error rather than anything actionable. It cannot create an account or
  // serve onboarding, so it isn't a way around the gate above.
  @Post('account-session')
  @RequirePermissions('payments:write')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: AccountSessionResponse })
  @ApiConflictResponse()
  createAccountSession(@CurrentUser() user: AuthenticatedUser) {
    return this.stripeConnectService.createManagementSession(user.accountId);
  }

  @Get('status')
  @RequirePermissions('payments:read')
  @ApiBearerAuth('JWT-auth')
  @ApiQuery({ name: 'refresh', required: false, type: Boolean })
  @ApiOkResponse({ type: StripeConnectStatus })
  getStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Query('refresh') refresh?: string,
  ) {
    return this.stripeConnectService.getStatus(
      user.accountId,
      refresh === 'true',
    );
  }
}
