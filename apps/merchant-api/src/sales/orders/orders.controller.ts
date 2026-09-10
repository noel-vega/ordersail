import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import { OrdersService } from './orders.service';
import { RefundsService } from './refunds.service';
import { CancelService } from './cancel.service';
import { PaginatedOrders } from './entities/paginated-orders.entity';
import { OrderDetail } from './entities/order-detail.entity';
import { OrderStatusChange } from './entities/order-status-change.entity';
import { OrderRefund } from './entities/order-refund.entity';
import { OrderCancellation } from './entities/order-cancellation.entity';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { RefundOrderDto } from './dto/refund-order.dto';
import { CancelOrderDto } from './dto/cancel-order.dto';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from 'src/shared/auth/decorators';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly refundsService: RefundsService,
    private readonly cancelService: CancelService,
  ) {}

  @Get()
  @RequirePermissions('orders:read')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: PaginatedOrders })
  findAll(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ordersService.findAll(limit, offset, user.accountId);
  }

  @Get(':id')
  @RequirePermissions('orders:read')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: OrderDetail })
  async findOne(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const order = await this.ordersService.findOne(+id, user.accountId);
    if (!order) throw new NotFoundException();
    return order;
  }

  // Narrow manual status correction — for the cases the refund / cancel flows
  // don't cover (e.g. marking a payment_failed order canceled). It does not
  // issue refunds or restock; moving a paid order to refunded is rejected here
  // (use POST /orders/:id/refunds).
  @Patch(':id/status')
  @RequirePermissions('orders:write')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: OrderStatusChange })
  updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateOrderStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ordersService.updateStatus(id, user.accountId, dto, user.sub);
  }

  // Full refund of a web order via the Stripe connected account. Partial /
  // line-item refunds land in OS-122.
  @Post(':id/refunds')
  @RequirePermissions('orders:refund')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: OrderRefund })
  refund(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RefundOrderDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.refundsService.refundOrder(id, user.accountId, dto, user.sub);
  }

  // Cancel an un-fulfilled order: refund (paid web orders) + restock + mark
  // canceled, one transaction. Rejected once anything has shipped.
  @Post(':id/cancel')
  @RequirePermissions('orders:cancel')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: OrderCancellation })
  cancel(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CancelOrderDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.cancelService.cancelOrder(id, user.accountId, dto, user.sub);
  }
}
