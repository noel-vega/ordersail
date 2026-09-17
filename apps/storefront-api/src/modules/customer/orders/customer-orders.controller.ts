import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiSecurity } from '@nestjs/swagger';
import { CustomerAuthGuard } from '../auth.guard';
import {
  CurrentCustomer,
  type AuthenticatedCustomer,
} from '../auth.decorators';
import { CustomerOrdersService } from './customer-orders.service';
import { ListCustomerOrdersQueryDto } from './dto/list-customer-orders-query.dto';
import { PaginatedCustomerOrders } from './entities/paginated-customer-orders.entity';

@ApiSecurity('AppKey-auth')
@ApiBearerAuth('CustomerJWT-auth')
@Controller('customer/orders')
@UseGuards(CustomerAuthGuard)
export class CustomerOrdersController {
  constructor(private readonly customerOrdersService: CustomerOrdersService) {}

  @Get()
  @ApiOkResponse({ type: PaginatedCustomerOrders })
  findAll(
    @Query() query: ListCustomerOrdersQueryDto,
    @CurrentCustomer() customer: AuthenticatedCustomer,
  ) {
    return this.customerOrdersService.findAll(
      query,
      customer.sub,
      customer.accountId,
    );
  }
}
