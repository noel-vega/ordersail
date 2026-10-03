import type { LogContext } from './index.ts';

// Where each log-context field goes on a span. Keyed by every LogContext field,
// so a new field can't be added without naming its attribute. packages/tracing
// builds its export allow-list from this map, so a name added here is exported
// without a second edit there.
//
// This module must import nothing at runtime (the type import above is erased):
// packages/tracing loads it before the instrumentations are installed, and
// anything it pulled in would be loaded unpatched.
export const SPAN_ATTRIBUTES: Readonly<Record<keyof LogContext, string>> = {
  correlationId: 'ordersail.correlation_id',
  accountId: 'ordersail.account_id',
  userId: 'ordersail.user_id',
  customerId: 'ordersail.customer_id',
  deviceId: 'ordersail.device_id',
  locationId: 'ordersail.location_id',
  appKeyId: 'ordersail.app_key_id',
  orderId: 'ordersail.order_id',
};
