import { Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
  NoMfaFactorRequired,
} from 'src/shared/auth/decorators';
import { FailedOrdersService } from './failed-orders.service';
import { FailedOrder } from './entities/failed-order.entity';
import { FailedOrdersList } from './entities/failed-orders-list.entity';

// Paid checkouts whose order the worker couldn't write, and a replay action.
// Staff-only (JWT + orders permissions), scoped to the caller's account.
@Controller('failed-orders')
@NoMfaFactorRequired()
export class FailedOrdersController {
  constructor(private readonly failedOrders: FailedOrdersService) {}

  @Get()
  @RequirePermissions('orders:read')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: FailedOrdersList })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.failedOrders.list(user.accountId);
  }

  @Post(':id/retry')
  @RequirePermissions('orders:write')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: FailedOrder })
  retry(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.failedOrders.retry(id, user.accountId, user.sub);
  }
}
