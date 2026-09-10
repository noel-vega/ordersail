import { Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery } from '@nestjs/swagger';
import { StripeConnectService } from './stripe-connect.service';
import { StripeConnectStatus } from './entities/stripe-connect-status.entity';
import { AccountSessionResponse } from './entities/account-session.entity';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from 'src/shared/auth/decorators';

// merchant-facing Connect routes. The `account.updated` webhook that keeps
// charges_enabled / details_submitted in sync lives in StripeWebhookController
// (the one Stripe webhook endpoint) and calls StripeConnectService directly.
@Controller('stripe-connect')
export class StripeConnectController {
  constructor(private readonly stripeConnectService: StripeConnectService) {}

  @Post('account-session')
  @RequirePermissions('payments:write')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: AccountSessionResponse })
  createAccountSession(@CurrentUser() user: AuthenticatedUser) {
    return this.stripeConnectService.createAccountSession(user.accountId);
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
