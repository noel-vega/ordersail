import {
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery } from '@nestjs/swagger';
import { CustomersService } from './customers.service';
import { PaginatedCustomers } from './entities/paginated-customers.entity';
import {
  CurrentUser,
  type AuthenticatedUser,
} from 'src/shared/auth/decorators';

@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
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
}
