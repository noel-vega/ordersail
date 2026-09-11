import { ApiProperty } from '@nestjs/swagger';
import { ORDER_STATUSES, type OrderStatus } from '../../orders/order-status';

// a lighter row than OrderListItem — no itemCount/fulfillmentStatus
// computation, just enough to render a customer's order history list
export class CustomerOrderSummary {
  @ApiProperty({ type: Number })
  id!: number;

  @ApiProperty({ enum: ['web', 'pos'] })
  channel!: 'web' | 'pos';

  @ApiProperty({ enum: ORDER_STATUSES })
  status!: OrderStatus;

  @ApiProperty({ type: Number })
  amountTotalCents!: number;

  @ApiProperty()
  createdAt!: Date;
}
