import { ApiProperty } from '@nestjs/swagger';
import { Customer } from './customer.entity';

export class PaginatedCustomers {
  @ApiProperty({ type: () => [Customer] })
  items!: Customer[];

  @ApiProperty({ type: Number })
  total!: number;

  @ApiProperty({ type: Number })
  limit!: number;

  @ApiProperty({ type: Number })
  offset!: number;
}
