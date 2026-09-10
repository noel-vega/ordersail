import { ApiProperty } from '@nestjs/swagger';
import { Fulfillment } from '../../fulfillments/entities/fulfillment.entity';
import { ORDER_STATUSES, type OrderStatus } from '../order-status';

export type FulfillmentStatus =
  'unfulfilled' | 'partially_fulfilled' | 'fulfilled';

export type OrderChannel = 'web' | 'pos';

export type OrderEventType =
  | 'status_changed'
  | 'refund'
  | 'cancellation'
  | 'payment'
  | 'fulfillment'
  | 'note';

class OrderShippingInfo {
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

  @ApiProperty({ type: Number, nullable: true })
  locationId!: number | null;
}

class OrderPayment {
  @ApiProperty({ enum: ['stripe', 'cash', 'card'] })
  method!: 'stripe' | 'cash' | 'card';

  // negative on a refund row, positive on a tender
  @ApiProperty({ type: Number })
  amountCents!: number;

  // cash tenders only — what the customer handed over; change due is
  // amountTenderedCents - amountCents
  @ApiProperty({ type: Number, nullable: true })
  amountTenderedCents!: number | null;

  // set on refund rows only
  @ApiProperty({ type: 'string', nullable: true })
  stripeRefundId!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  reason!: string | null;
}

class OrderEvent {
  @ApiProperty({ type: Number })
  id!: number;

  @ApiProperty({
    enum: [
      'status_changed',
      'refund',
      'cancellation',
      'payment',
      'fulfillment',
      'note',
    ],
  })
  type!: OrderEventType;

  // pre-rendered human summary — the timeline renders this verbatim
  @ApiProperty()
  message!: string;

  @ApiProperty({ enum: ['staff', 'system', 'customer'] })
  actorType!: 'staff' | 'system' | 'customer';

  // the staff member's name; null for system events or a deleted user
  @ApiProperty({ type: 'string', nullable: true })
  actorName!: string | null;

  @ApiProperty()
  createdAt!: Date;
}

class OrderItemAllocation {
  @ApiProperty({ type: Number })
  locationId!: number;

  @ApiProperty()
  locationName!: string;

  @ApiProperty({ type: Number })
  quantity!: number;
}

class OrderDetailItem {
  @ApiProperty({ type: Number })
  id!: number;

  @ApiProperty({ type: Number, nullable: true })
  variantId!: number | null;

  @ApiProperty()
  productName!: string;

  @ApiProperty({ type: 'string', nullable: true })
  sku!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  optionsLabel!: string | null;

  @ApiProperty({ type: Number })
  priceCents!: number;

  @ApiProperty({ type: Number })
  quantity!: number;

  @ApiProperty({ type: Number })
  fulfilledQuantity!: number;

  @ApiProperty({ type: Number })
  remainingQuantity!: number;

  // units of this line already covered by a line-item refund (OS-122)
  @ApiProperty({ type: Number })
  refundedQuantity!: number;

  // where this item's stock was actually pulled from at order time (see
  // inventoryMovementsTable.orderItemId) — informs which location(s) a
  // merchant can realistically ship this item from, but isn't a hard limit
  // enforced by the fulfillment endpoints (see FulfillmentsService)
  @ApiProperty({ type: () => [OrderItemAllocation] })
  allocations!: OrderItemAllocation[];
}

export class OrderDetail {
  @ApiProperty({ type: Number })
  id!: number;

  @ApiProperty({ enum: ['web', 'pos'] })
  channel!: OrderChannel;

  // financial lifecycle — distinct from the derived fulfillmentStatus below
  @ApiProperty({ enum: ORDER_STATUSES })
  status!: OrderStatus;

  @ApiProperty({ type: 'string', nullable: true })
  customerName!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  customerEmail!: string | null;

  // present for web orders, null for in-person POS sales
  @ApiProperty({ type: () => OrderShippingInfo, nullable: true })
  shipping!: OrderShippingInfo | null;

  @ApiProperty({ type: () => [OrderPayment] })
  payments!: OrderPayment[];

  @ApiProperty({ type: Number })
  subtotalCents!: number;

  @ApiProperty({ type: Number })
  amountTotalCents!: number;

  @ApiProperty({ type: Number })
  shippingCents!: number;

  // derived from items[].fulfilledQuantity vs .quantity at read time, not
  // stored — can't drift out of sync with the fulfillments that back it
  @ApiProperty({ enum: ['unfulfilled', 'partially_fulfilled', 'fulfilled'] })
  fulfillmentStatus!: FulfillmentStatus;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({ type: () => [OrderDetailItem] })
  items!: OrderDetailItem[];

  @ApiProperty({ type: () => [Fulfillment] })
  fulfillments!: Fulfillment[];

  // audit trail, newest first
  @ApiProperty({ type: () => [OrderEvent] })
  events!: OrderEvent[];
}
