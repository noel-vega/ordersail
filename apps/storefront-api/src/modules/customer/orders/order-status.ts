import { orderStatusEnum } from 'db';

export type OrderStatus = (typeof orderStatusEnum.enumValues)[number];
export const ORDER_STATUSES = orderStatusEnum.enumValues;

export type FulfillmentStatus =
  'unfulfilled' | 'partially_fulfilled' | 'fulfilled';
export const FULFILLMENT_STATUSES: FulfillmentStatus[] = [
  'unfulfilled',
  'partially_fulfilled',
  'fulfilled',
];

// derived at read time from fulfillment_items vs order_items, never stored —
// same rule as merchant-api's OrdersService so a shopper and the merchant
// always see the same fulfillment state for an order
export function deriveFulfillmentStatus(
  totalQuantity: number,
  fulfilledQuantity: number,
): FulfillmentStatus {
  if (fulfilledQuantity <= 0) return 'unfulfilled';
  if (fulfilledQuantity >= totalQuantity) return 'fulfilled';
  return 'partially_fulfilled';
}
