import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import { FulfillmentsService } from './fulfillments.service';
import { GetFulfillmentRatesDto } from './dto/get-fulfillment-rates.dto';
import { CreateFulfillmentDto } from './dto/create-fulfillment.dto';
import { ShippingRate } from './entities/shipping-rate.entity';
import { OrderDetail } from '../orders/entities/order-detail.entity';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from 'src/shared/auth/decorators';

@Controller('fulfillments')
export class FulfillmentsController {
  constructor(private readonly fulfillmentsService: FulfillmentsService) {}

  @Post('rates')
  @RequirePermissions('fulfillments:write')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: [ShippingRate] })
  getRates(
    @Body() dto: GetFulfillmentRatesDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.fulfillmentsService.getRates(dto, user.accountId);
  }

  @Post()
  @RequirePermissions('fulfillments:write')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: OrderDetail })
  create(
    @Body() dto: CreateFulfillmentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.fulfillmentsService.create(dto, user.accountId);
  }
}
