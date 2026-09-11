import {
  type AnyPgColumn,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { timestampAt } from "../utils.js";
import { accountsTable } from "./accounts.js";
import { productVariantsTable } from "./products.js";
import { locationsTable } from "./inventory.js";
import { posDevicesTable } from "./pos-devices.js";
import { usersTable } from "./users.js";
import { customersTable } from "./customers.js";
import { createInsertSchema, createSelectSchema } from "drizzle-orm/zod";
import z from "zod";

// how a sale was made — 'web' is a storefront checkout (Stripe, ships to an
// address), 'pos' is an in-person sale rung up on a paired POS device
export const orderChannelEnum = pgEnum("order_channel", ["web", "pos"]);

// tender type on an order_payments row. 'stripe' is the storefront checkout;
// 'cash'/'card' are POS tenders — recorded, not processed.
export const orderPaymentMethodEnum = pgEnum("order_payment_method", [
  "stripe",
  "cash",
  "card",
]);

// an order's financial lifecycle — deliberately separate from the read-time
// derived fulfillment status (unfulfilled / partially_fulfilled / fulfilled),
// which stays computed and unstored. 'pending' / 'payment_failed' are reserved
// for a future provisional-order path; today the only writers (checkout worker,
// pos-api) create orders already 'paid'. See Payments M2.
export const orderStatusEnum = pgEnum("order_status", [
  "pending",
  "paid",
  "partially_refunded",
  "refunded",
  "canceled",
  "payment_failed",
]);

// a completed sale. 'web' rows are created by the checkout webhook once
// Stripe confirms payment; 'pos' rows are created synchronously by pos-api
// when a cashier completes a sale. Channel-specific data lives in
// order_shipping (web ship-to address) and order_payments (all channels).
export const ordersTable = pgTable("orders", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  accountId: integer()
    .notNull()
    .references(() => accountsTable.id, { onDelete: "cascade" }),
  channel: orderChannelEnum().notNull().default("web"),
  // the physical location a POS sale happened at — null for web orders.
  // distinct from order_shipping.locationId (a checkout-time ship-from rate
  // estimate) and fulfillments.locationId (where a label actually shipped from)
  locationId: integer().references(() => locationsTable.id, {
    onDelete: "set null",
  }),
  posDeviceId: integer().references(() => posDevicesTable.id, {
    onDelete: "set null",
  }),
  // null for POS walk-in sales; the guest's details for a web order
  customerEmail: text(),
  customerName: text(),
  // set when customerEmail matches a registered customersTable row at
  // checkout time (OS-189) — null for guest checkouts and POS sales, same
  // as customerEmail itself. The email fields above stay the source of
  // truth for display/receipts; this is purely for joining a customer's
  // order history without a fragile email string-match at read time.
  customerId: integer().references(() => customersTable.id, {
    onDelete: "set null",
  }),
  subtotalCents: integer().notNull(),
  // reserved for future tax collection — always 0 today
  taxCents: integer().notNull().default(0),
  // from Stripe's shipping_cost.amount_total at checkout time; 0 for POS
  shippingCents: integer().notNull().default(0),
  // the actual amount charged / total collected
  amountTotalCents: integer().notNull(),
  // financial lifecycle (see orderStatusEnum). No column default — the two
  // writers set it explicitly on insert; the M2 migration backfills every
  // pre-existing row to 'paid'.
  status: orderStatusEnum().notNull(),
  // null until the order-confirmation email job is successfully enqueued
  // (web only) — lets the worker tell "already emailed" apart from "order
  // committed but the process died before the email went out"
  confirmationEmailQueuedAt: timestamp("confirmation_email_queued_at"),
  createdAt: timestampAt("created_at"),
  updatedAt: timestampAt("updated_at"),
}, (t) => [index().on(t.accountId, t.status)]);

export const SelectOrderSchema = createSelectSchema(ordersTable);
export type SelectOrder = z.infer<typeof SelectOrderSchema>;
export const InsertOrderSchema = createInsertSchema(ordersTable);
export type InsertOrder = z.infer<typeof InsertOrderSchema>;

// the ship-to address for a web order — one row per order, channel 'web'
// only. POS sales have no row here.
export const orderShippingTable = pgTable(
  "order_shipping",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    orderId: integer()
      .notNull()
      .references(() => ordersTable.id, { onDelete: "cascade" }),
    line1: text().notNull(),
    line2: text(),
    city: text().notNull(),
    state: text(),
    postalCode: text().notNull(),
    country: text().notNull(),
    // which location's address was quoted as ship-from at checkout — only a
    // rate-estimation input, independent of fulfillments.locationId
    locationId: integer().references(() => locationsTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestampAt("created_at"),
  },
  (t) => [unique().on(t.orderId)],
);

export const SelectOrderShippingSchema = createSelectSchema(orderShippingTable);
export type SelectOrderShipping = z.infer<typeof SelectOrderShippingSchema>;
export const InsertOrderShippingSchema = createInsertSchema(orderShippingTable);
export type InsertOrderShipping = z.infer<typeof InsertOrderShippingSchema>;

// one tender against an order, or a refund of one. A web order gets a single
// positive 'stripe' row carrying the checkout session (still the webhook
// idempotency key) + payment intent. A POS order gets a positive 'cash' or
// 'card' row; cash also records amountTenderedCents so change due can be
// reconstructed. A refund is a **negative** row pointing at the tender it
// reverses via parentPaymentId (M2); net collected = SUM(amountCents).
export const orderPaymentsTable = pgTable("order_payments", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  orderId: integer()
    .notNull()
    .references(() => ordersTable.id, { onDelete: "cascade" }),
  method: orderPaymentMethodEnum().notNull(),
  // positive on a tender, negative on a refund row
  amountCents: integer().notNull(),
  // cash tenders only — what the customer handed over (>= amountCents);
  // null for card / stripe
  amountTenderedCents: integer(),
  // Stripe checkout only — doubles as the webhook's idempotency key
  stripeCheckoutSessionId: text().unique(),
  stripePaymentIntentId: text(),
  // refund rows only — the Stripe refund id (unique, so a redelivered
  // charge.refunded webhook can't write a duplicate row) + a free-text reason
  stripeRefundId: text().unique(),
  reason: text(),
  // refund rows only — the tender this refund reverses
  parentPaymentId: integer().references(
    (): AnyPgColumn => orderPaymentsTable.id,
    { onDelete: "set null" },
  ),
  createdAt: timestampAt("created_at"),
});

export const SelectOrderPaymentSchema = createSelectSchema(orderPaymentsTable);
export type SelectOrderPayment = z.infer<typeof SelectOrderPaymentSchema>;
export const InsertOrderPaymentSchema = createInsertSchema(orderPaymentsTable);
export type InsertOrderPayment = z.infer<typeof InsertOrderPaymentSchema>;

// snapshotted at order time — unlike cart_items, an order is a permanent
// record and must survive the variant/product it was placed against changing
// or being deleted later
export const orderItemsTable = pgTable("order_items", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  orderId: integer()
    .notNull()
    .references(() => ordersTable.id, { onDelete: "cascade" }),
  variantId: integer().references(() => productVariantsTable.id, {
    onDelete: "set null",
  }),
  productName: varchar({ length: 255 }).notNull(),
  sku: varchar({ length: 100 }),
  optionsLabel: text(),
  priceCents: integer().notNull(),
  quantity: integer().notNull(),
  // snapshotted from the variant at order time, same reasoning as
  // productName/sku above — needed later to re-quote a shipping label
  // without depending on the variant still existing
  weightOz: integer(),
  createdAt: timestampAt("created_at"),
});

export const SelectOrderItemSchema = createSelectSchema(orderItemsTable);
export type SelectOrderItem = z.infer<typeof SelectOrderItemSchema>;
export const InsertOrderItemSchema = createInsertSchema(orderItemsTable);
export type InsertOrderItem = z.infer<typeof InsertOrderItemSchema>;

// one row per label actually purchased — an order can have any number of
// these (partial shipments, or split across locations because inventory for
// the order was allocated across more than one, see inventoryMovementsTable
// .orderItemId). Unlike orderItemsTable this is never created at checkout
// time, only later via the admin fulfillment flow.
export const fulfillmentsTable = pgTable("fulfillments", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  orderId: integer()
    .notNull()
    .references(() => ordersTable.id, { onDelete: "cascade" }),
  // the ship-from address actually used for this shipment — deliberately
  // not deletable out from under a purchased label's history, unlike
  // order_shipping.locationId's "set null" (that one's just a checkout-time
  // estimate, this one is what Shippo actually shipped from)
  locationId: integer()
    .notNull()
    .references(() => locationsTable.id),
  shippoTransactionId: text(),
  trackingNumber: text(),
  trackingUrl: text(),
  labelUrl: text(),
  shippingCarrier: text(),
  shippingServiceLevel: text(),
  amountCents: integer().notNull(),
  createdAt: timestampAt("created_at"),
  updatedAt: timestampAt("updated_at"),
});

export const SelectFulfillmentSchema = createSelectSchema(fulfillmentsTable);
export type SelectFulfillment = z.infer<typeof SelectFulfillmentSchema>;
export const InsertFulfillmentSchema = createInsertSchema(fulfillmentsTable);
export type InsertFulfillment = z.infer<typeof InsertFulfillmentSchema>;

// which order item(s), and how much of each, a fulfillment covers — an
// order item's quantity can be split across multiple fulfillments over time
// (e.g. some in stock now, the rest backordered and shipped later)
export const fulfillmentItemsTable = pgTable("fulfillment_items", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  fulfillmentId: integer()
    .notNull()
    .references(() => fulfillmentsTable.id, { onDelete: "cascade" }),
  orderItemId: integer()
    .notNull()
    .references(() => orderItemsTable.id, { onDelete: "cascade" }),
  quantity: integer().notNull(),
  createdAt: timestampAt("created_at"),
});

export const SelectFulfillmentItemSchema = createSelectSchema(
  fulfillmentItemsTable,
);
export type SelectFulfillmentItem = z.infer<typeof SelectFulfillmentItemSchema>;
export const InsertFulfillmentItemSchema = createInsertSchema(
  fulfillmentItemsTable,
);
export type InsertFulfillmentItem = z.infer<typeof InsertFulfillmentItemSchema>;

// a checkout that paid but whose order the worker could not write, even after
// exhausting every retry (ORDER_JOB_OPTIONS.attempts). The BullMQ job stays in
// Redis, but that's invisible to anyone not reading worker logs — this row is
// the first-class surface: a paid customer with no order is the worst failure
// this system has. apps/worker upserts it from its 'failed' handler; the
// merchant-api sales context lists it and replays it (re-enqueues `payload`).
export const failedOrdersTable = pgTable("failed_orders", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  // the Stripe checkout session — unique, so a replay that fails again updates
  // this row instead of piling up duplicates. Same key the worker dedupes on
  // (order_payments.stripeCheckoutSessionId), so a later successful write for
  // this session can resolve the row.
  stripeCheckoutSessionId: text().notNull().unique(),
  stripePaymentIntentId: text(),
  accountId: integer()
    .notNull()
    .references(() => accountsTable.id, { onDelete: "cascade" }),
  // BullMQ job id of the last failed attempt — for cross-referencing worker
  // logs / Redis
  jobId: text(),
  // the fully-resolved order-job payload (queue's OrderJobData) the worker was
  // trying to write. Stored verbatim so a replay re-enqueues it without
  // re-deriving anything from Stripe or the (by now possibly deleted) cart.
  payload: jsonb().notNull(),
  errorMessage: text().notNull(),
  attempts: integer().notNull(),
  // set once the order is finally created — by a manual replay, or by any
  // later job that writes the order for this session
  resolvedAt: timestamp("resolved_at"),
  // 'worker' (a later job succeeded on its own) or the staff user id that
  // triggered the replay
  resolvedBy: text(),
  createdAt: timestampAt("created_at"),
  updatedAt: timestampAt("updated_at"),
});

export const SelectFailedOrderSchema = createSelectSchema(failedOrdersTable);
export type SelectFailedOrder = z.infer<typeof SelectFailedOrderSchema>;
export const InsertFailedOrderSchema = createInsertSchema(failedOrdersTable);
export type InsertFailedOrder = z.infer<typeof InsertFailedOrderSchema>;

// what an order_events row records. Mostly a status change, but also the
// human-visible trail for refunds / cancellations / disputes rendered on the
// order detail page's activity timeline (M2).
export const orderEventTypeEnum = pgEnum("order_event_type", [
  "status_changed",
  "refund",
  "cancellation",
  "payment",
  "fulfillment",
  "note",
]);

// who caused the event — a signed-in staff user, an automated path (webhook,
// worker), or the customer.
export const orderActorTypeEnum = pgEnum("order_actor_type", [
  "staff",
  "system",
  "customer",
]);

// append-only per-order audit trail. `data` carries type-specific detail
// ({ from, to } for a status change; { grossAmountCents, stripeRefundId, reason,
// lines } for a refund; …); `message` is the pre-rendered summary the timeline
// shows.
export const orderEventsTable = pgTable(
  "order_events",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    orderId: integer()
      .notNull()
      .references(() => ordersTable.id, { onDelete: "cascade" }),
    type: orderEventTypeEnum().notNull(),
    data: jsonb().$type<Record<string, unknown>>(),
    message: text().notNull(),
    actorType: orderActorTypeEnum().notNull(),
    // null for system events, or when the staff user was since deleted
    actorUserId: integer().references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestampAt("created_at"),
  },
  (t) => [index().on(t.orderId, t.createdAt)],
);

export const SelectOrderEventSchema = createSelectSchema(orderEventsTable);
export type SelectOrderEvent = z.infer<typeof SelectOrderEventSchema>;
export const InsertOrderEventSchema = createInsertSchema(orderEventsTable);
export type InsertOrderEvent = z.infer<typeof InsertOrderEventSchema>;

// which order items + quantities a line-item refund covered — only written for
// `lines`-mode refunds (an ad-hoc amount refund has no rows here). Makes the
// per-line "how much of this item is still refundable" cap a simple SUM. (M2)
export const orderRefundLinesTable = pgTable(
  "order_refund_lines",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    // the negative order_payments row this line belongs to
    refundPaymentId: integer()
      .notNull()
      .references(() => orderPaymentsTable.id, { onDelete: "cascade" }),
    orderItemId: integer()
      .notNull()
      .references(() => orderItemsTable.id, { onDelete: "cascade" }),
    quantity: integer().notNull(),
    createdAt: timestampAt("created_at"),
  },
  (t) => [index().on(t.refundPaymentId)],
);

export const SelectOrderRefundLineSchema =
  createSelectSchema(orderRefundLinesTable);
export type SelectOrderRefundLine = z.infer<typeof SelectOrderRefundLineSchema>;
export const InsertOrderRefundLineSchema =
  createInsertSchema(orderRefundLinesTable);
export type InsertOrderRefundLine = z.infer<typeof InsertOrderRefundLineSchema>;
