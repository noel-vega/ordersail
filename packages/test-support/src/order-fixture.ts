// A fully-written paid order, the way the checkout worker / pos-api leaves one:
// account + staff user + a location + a single-variant product with stock, an
// `orders` row, its `order_payments` tender, one `order_items` row, and the
// `sold` inventory movement + decremented balance. The shared seed for the
// order-lifecycle specs (refund / cancel / status transitions).
import {
  and,
  eq,
  inventoryMovementsTable,
  inventoryTable,
  orderStatusEnum,
} from "db";
import type { TestDb } from "./test-db/db.js";
import {
  insertAccount,
  insertLocation,
  insertOrder,
  insertOrderItem,
  insertOrderPayment,
  insertProductWithVariants,
  insertUser,
} from "./fixtures.js";

type OrderStatus = (typeof orderStatusEnum.enumValues)[number];

export interface PaidOrderScenario {
  accountId: number;
  staffId: number;
  orderId: number;
  itemId: number;
  variantId: number;
  locationId: number;
  paymentId: number | null;
  priceCents: number;
  quantity: number;
  totalCents: number;
  startStock: number;
}

export async function seedPaidWebOrder(
  db: TestDb,
  opts: {
    channel?: "web" | "pos";
    status?: OrderStatus;
    // false → an order with no tender (a payment_failed / pending path)
    withPayment?: boolean;
    priceCents?: number;
    quantity?: number;
    startStock?: number;
  } = {},
): Promise<PaidOrderScenario> {
  const channel = opts.channel ?? "web";
  const priceCents = opts.priceCents ?? 5000;
  const quantity = opts.quantity ?? 2;
  const startStock = opts.startStock ?? 10;
  const totalCents = priceCents * quantity;

  const account = await insertAccount(db);
  const staff = await insertUser(db, { accountId: account.id });
  const location = await insertLocation(db, { accountId: account.id });
  const [variant] = await insertProductWithVariants(db, {
    accountId: account.id,
    variants: [
      { priceCents, stock: [{ locationId: location.id, stock: startStock }] },
    ],
  });

  const order = await insertOrder(db, {
    accountId: account.id,
    channel,
    status: opts.status ?? "paid",
    subtotalCents: totalCents,
    amountTotalCents: totalCents,
  });

  let paymentId: number | null = null;
  if (opts.withPayment !== false) {
    const payment = await insertOrderPayment(db, {
      orderId: order.id,
      method: channel === "pos" ? "card" : "stripe",
      amountCents: totalCents,
      stripePaymentIntentId: channel === "pos" ? null : "pi_test_1",
    });
    paymentId = payment.id;
  }

  const item = await insertOrderItem(db, {
    orderId: order.id,
    variantId: variant.id,
    priceCents,
    quantity,
  });

  await db.insert(inventoryMovementsTable).values({
    orderItemId: item.id,
    variantId: variant.id,
    locationId: location.id,
    delta: -quantity,
    reason: "sold",
  });
  await db
    .update(inventoryTable)
    .set({ stock: startStock - quantity })
    .where(
      and(
        eq(inventoryTable.variantId, variant.id),
        eq(inventoryTable.locationId, location.id),
      ),
    );

  return {
    accountId: account.id,
    staffId: staff.id,
    orderId: order.id,
    itemId: item.id,
    variantId: variant.id,
    locationId: location.id,
    paymentId,
    priceCents,
    quantity,
    totalCents,
    startStock,
  };
}
