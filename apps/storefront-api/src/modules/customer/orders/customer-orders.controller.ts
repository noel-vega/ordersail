import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiSecurity,
} from '@nestjs/swagger';
import { CustomerAuthGuard } from '../auth.guard';
import {
  CurrentCustomer,
  type AuthenticatedCustomer,
} from '../auth.decorators';
import { CustomerOrdersService } from './customer-orders.service';
import { ListCustomerOrdersQueryDto } from './dto/list-customer-orders-query.dto';
import { PaginatedCustomerOrders } from './entities/paginated-customer-orders.entity';
import { CustomerOrderDetail } from './entities/customer-order-detail.entity';

// one requirement object = both schemes required (separate decorators would
// emit two alternatives, i.e. either one alone would satisfy the contract)
@ApiSecurity({ 'AppKey-auth': [], 'CustomerJWT-auth': [] })
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

  @Get(':id')
  @ApiOkResponse({ type: CustomerOrderDetail })
  @ApiNotFoundResponse()
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCustomer() customer: AuthenticatedCustomer,
  ): Promise<CustomerOrderDetail> {
    const order = await this.customerOrdersService.findOne(
      id,
      customer.sub,
      customer.accountId,
    );
    if (!order) throw new NotFoundException();
    return order;
  }
}
