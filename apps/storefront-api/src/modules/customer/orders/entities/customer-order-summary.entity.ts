import { ApiProperty } from '@nestjs/swagger';
import {
  FULFILLMENT_STATUSES,
  ORDER_STATUSES,
  type FulfillmentStatus,
  type OrderStatus,
} from '../order-status';

// one row of a signed-in customer's order history — enough to render a list
// entry; the full breakdown is CustomerOrderDetail (GET /customer/orders/:id)
export class CustomerOrderSummary {
  @ApiProperty({ type: Number })
  id!: number;

  @ApiProperty({ enum: ORDER_STATUSES })
  status!: OrderStatus;

  @ApiProperty({ enum: FULFILLMENT_STATUSES })
  fulfillmentStatus!: FulfillmentStatus;

  // total units across all line items, not the number of distinct lines
  @ApiProperty({ type: Number })
  itemCount!: number;

  @ApiProperty({ type: Number })
  amountTotalCents!: number;

  @ApiProperty()
  createdAt!: Date;
}
