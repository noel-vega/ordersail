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

  // Connecting an account for the FIRST time — the money action, and the one
  // that needs a second factor.
  //
  // Split from account-session rather than gating that route in place,
  // because account-session is dual-use: merchant-web initializes Connect.js
  // whenever `showOnboarding || connected`, so an already-connected merchant
  // hits it just to render account management and balances. Gating it would
  // break their Payments page for a factor they never needed — and the
  // failure would surface inside Connect.js's fetchClientSecret callback,
  // where a 403 is an opaque Stripe error rather than anything actionable.
  @Post('onboarding-session')
  @RequirePermissions('payments:write')
  @RequireMfaFactor()
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: AccountSessionResponse })
  createOnboardingSession(@CurrentUser() user: AuthenticatedUser) {
    return this.stripeConnectService.createOnboardingSession(user.accountId);
  }

  // Ungated: the embedded management and balance components call this on
  // every Payments page load for a merchant who is already connected. It
  // cannot create an account or serve onboarding, so it isn't a way around
  // the gate above.
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
