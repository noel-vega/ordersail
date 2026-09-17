import { ApiProperty } from '@nestjs/swagger';
import {
  FULFILLMENT_STATUSES,
  ORDER_STATUSES,
  type FulfillmentStatus,
  type OrderStatus,
} from '../order-status';

// Customer-facing counterpart of merchant-api's OrderDetail. Deliberately
// narrower: no order_events (staff audit trail), no stock allocations or
// ship-from locations, no label URL / label cost, no Stripe ids or refund
// reasons (free text a merchant writes for themselves).

class CustomerOrderShipping {
  @ApiProperty()
  line1!: string;

  @ApiProperty({ type: 'string', nullable: true })
  line2!: string | null;

  @ApiProperty()
  city!: string;

  @ApiProperty({ type: 'string', nullable: true })
  state!: string | null;

  @ApiProperty()
  postalCode!: string;

  @ApiProperty()
  country!: string;
}

class CustomerOrderPayment {
  @ApiProperty({ enum: ['stripe', 'cash', 'card'] })
  method!: 'stripe' | 'cash' | 'card';

  // positive on a payment, negative on a refund
  @ApiProperty({ type: Number })
  amountCents!: number;

  @ApiProperty()
  createdAt!: Date;
}

class CustomerOrderItem {
  @ApiProperty({ type: Number })
  id!: number;

  // null once the variant has been deleted — the line itself is a snapshot
  @ApiProperty({ type: Number, nullable: true })
  variantId!: number | null;

  @ApiProperty()
  productName!: string;

  @ApiProperty({ type: 'string', nullable: true })
  sku!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  optionsLabel!: string | null;

  // unit price at order time
  @ApiProperty({ type: Number })
  priceCents!: number;

  @ApiProperty({ type: Number })
  quantity!: number;

  @ApiProperty({ type: Number })
  fulfilledQuantity!: number;

  @ApiProperty({ type: Number })
  refundedQuantity!: number;
}

class CustomerFulfillmentItem {
  @ApiProperty({ type: Number })
  orderItemId!: number;

  @ApiProperty({ type: Number })
  quantity!: number;
}

class CustomerOrderFulfillment {
  @ApiProperty({ type: Number })
  id!: number;

  @ApiProperty({ type: 'string', nullable: true })
  shippingCarrier!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  shippingServiceLevel!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  trackingNumber!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  trackingUrl!: string | null;

  // when the label was purchased
  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({ type: () => [CustomerFulfillmentItem] })
  items!: CustomerFulfillmentItem[];
}

export class CustomerOrderDetail {
  @ApiProperty({ type: Number })
  id!: number;

  @ApiProperty({ enum: ORDER_STATUSES })
  status!: OrderStatus;

  @ApiProperty({ enum: FULFILLMENT_STATUSES })
  fulfillmentStatus!: FulfillmentStatus;

  @ApiProperty({ type: 'string', nullable: true })
  customerName!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  customerEmail!: string | null;

  // null for an order with no ship-to address (e.g. an in-person sale)
  @ApiProperty({ type: () => CustomerOrderShipping, nullable: true })
  shipping!: CustomerOrderShipping | null;

  @ApiProperty({ type: Number })
  subtotalCents!: number;

  @ApiProperty({ type: Number })
  shippingCents!: number;

  @ApiProperty({ type: Number })
  taxCents!: number;

  @ApiProperty({ type: Number })
  amountTotalCents!: number;

  // oldest first; refunds appear as negative rows
  @ApiProperty({ type: () => [CustomerOrderPayment] })
  payments!: CustomerOrderPayment[];

  @ApiProperty({ type: () => [CustomerOrderItem] })
  items!: CustomerOrderItem[];

  // oldest first
  @ApiProperty({ type: () => [CustomerOrderFulfillment] })
  fulfillments!: CustomerOrderFulfillment[];

  @ApiProperty()
  createdAt!: Date;
}
