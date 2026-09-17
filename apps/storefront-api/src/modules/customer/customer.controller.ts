import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiSecurity } from '@nestjs/swagger';
import { CustomerService } from './customer.service';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { Customer } from './entities/customer.entity';
import { CustomerAuthGuard } from './auth.guard';
import { CurrentCustomer, type AuthenticatedCustomer } from './auth.decorators';

// one requirement object = both schemes required (separate decorators would
// emit two alternatives, i.e. either one alone would satisfy the contract)
@ApiSecurity({ 'AppKey-auth': [], 'CustomerJWT-auth': [] })
@Controller('customer')
@UseGuards(CustomerAuthGuard)
export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  @Get()
  @ApiOkResponse({ type: Customer })
  findOne(@CurrentCustomer() customer: AuthenticatedCustomer) {
    return this.customerService.findOne(customer.sub);
  }

  @Patch()
  @ApiOkResponse({ type: Customer })
  update(
    @Body() dto: UpdateCustomerDto,
    @CurrentCustomer() customer: AuthenticatedCustomer,
  ) {
    return this.customerService.update(customer.sub, dto);
  }
}
