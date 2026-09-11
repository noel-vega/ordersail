import { ApiProperty } from '@nestjs/swagger';
import { Customer } from './customer.entity';

export class CustomerDetail extends Customer {
  // sum of amountTotalCents across every order linked to this customer
  // (orders.customerId — OS-189); 0 for a customer with no orders yet
  @ApiProperty({ type: Number })
  lifetimeValueCents!: number;
}
