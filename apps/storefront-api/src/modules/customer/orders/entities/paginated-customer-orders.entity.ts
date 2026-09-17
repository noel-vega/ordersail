import { ApiProperty } from '@nestjs/swagger';
import { CustomerOrderSummary } from './customer-order-summary.entity';

export class PaginatedCustomerOrders {
  @ApiProperty({ type: () => [CustomerOrderSummary] })
  items!: CustomerOrderSummary[];

  @ApiProperty({ type: Number })
  total!: number;

  @ApiProperty({ type: Number })
  limit!: number;

  @ApiProperty({ type: Number })
  offset!: number;
}
