import {
  Controller,
  DefaultValuePipe,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery } from '@nestjs/swagger';
import { CustomersService } from './customers.service';
import { PaginatedCustomers } from './entities/paginated-customers.entity';
import { CustomerDetail } from './entities/customer-detail.entity';
import { PaginatedCustomerOrders } from './entities/paginated-customer-orders.entity';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from 'src/shared/auth/decorators';

@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  @RequirePermissions('customers:read')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: PaginatedCustomers })
  @ApiQuery({ name: 'q', required: false, description: 'name or email match' })
  findAll(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @CurrentUser() user: AuthenticatedUser,
    @Query('q') q?: string,
  ) {
    return this.customersService.findAll(limit, offset, user.accountId, q);
  }

  @Get(':id')
  @RequirePermissions('customers:read')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: CustomerDetail })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const customer = await this.customersService.findOne(id, user.accountId);
    if (!customer) throw new NotFoundException();
    return customer;
  }

  // order history is presented as part of the customer record — no
  // additional orders:read check (see OS-189)
  @Get(':id/orders')
  @RequirePermissions('customers:read')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: PaginatedCustomerOrders })
  findOrders(
    @Param('id', ParseIntPipe) id: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.customersService.findOrders(id, user.accountId, limit, offset);
  }
}
