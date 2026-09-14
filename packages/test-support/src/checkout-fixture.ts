// The canonical "paid web checkout" — one scenario, pinned to by both sides
// of the checkout→order path so a change on either side that breaks the
// pairing fails a test:
//
//   producer  (session + cart  →  checkout-completed job payload)
//     today:  storefront-api  CheckoutService.handleWebhookEvent
//     M9:     merchant-api    sales, off a checkout.session.paid event
//   consumer  (job payload  →  order + shipping + payment + items + stock)
//     apps/worker  OrdersProcessor
//
// `canonicalOrderJobData` is the contract between them; `checkoutSession`
// feeds the producer, `assertCanonicalOrderWritten` checks the consumer.
import {
  and,
  cartsTable,
  eq,
  inventoryMovementsTable,
  inventoryTable,
  orderItemsTable,
  orderPaymentsTable,
  orderShippingTable,
  ordersTable,
} from 'db';
import type { TestDb } from './test-db/db.js';
import {
  insertAccount,
  insertCart,
  insertLocation,
  insertProductWithVariants,
  insertStripeAccount,
} from './fixtures.js';

export const CHECKOUT_SESSION_ID = 'cs_test_e2e_1';
export const CHECKOUT_PAYMENT_INTENT_ID = 'pi_test_e2e_1';
export const CHECKOUT_CART_TOKEN = 'cart-tok-e2e';

const SHIPPING_ADDRESS = {
  line1: '1 Market St',
  line2: null as string | null,
  city: 'San Francisco',
  state: 'CA',
  postal_code: '94105',
  country: 'US',
};

const CUSTOMER = { email: 'buyer@e2e.test', name: 'Test Buyer' };

// two lines: one with an option ("Size: 8"), one bare (null sku, no options)
const AF1 = { priceCents: 11500, sku: 'AF1-8', weightOz: 32, quantity: 2 };
const TEE = { priceCents: 3000, sku: null, weightOz: null, quantity: 1 };
const PRODUCT_NAME = 'Nike Air Force 1';

const SUBTOTAL_CENTS = AF1.priceCents * AF1.quantity + TEE.priceCents * TEE.quantity; // 26000
const SHIPPING_CENTS = 845;
const AMOUNT_TOTAL_CENTS = SUBTOTAL_CENTS + SHIPPING_CENTS; // 26845

const AF1_START_STOCK = 10;
const TEE_START_STOCK = 5;

export interface CheckoutScenario {
  accountId: number;
  connectedAccountId: string;
  cartToken: string;
  shipFromLocationId: number;
  otherLocationId: number;
  variantWithOptions: number; // AF1
  variantNoOptions: number; // TEE
}

// account + connected Stripe account + two locations + a two-variant product
// (AF1 stock at the ship-from location, TEE stock at the other) + a cart whose
// token matches the canonical session's metadata.
export async function seedCheckoutScenario(db: TestDb): Promise<CheckoutScenario> {
  const account = await insertAccount(db);
  const stripeAccount = await insertStripeAccount(db, { accountId: account.id });
  const shipFrom = await insertLocation(db, { accountId: account.id });
  const other = await insertLocation(db, { accountId: account.id });

  const [af1, tee] = await insertProductWithVariants(db, {
    accountId: account.id,
    productName: PRODUCT_NAME,
    variants: [
      {
        priceCents: AF1.priceCents,
        sku: AF1.sku,
        weightOz: AF1.weightOz,
        option: { name: 'Size', value: '8' },
        stock: [{ locationId: shipFrom.id, stock: AF1_START_STOCK }],
      },
      {
        priceCents: TEE.priceCents,
        sku: TEE.sku,
        weightOz: TEE.weightOz,
        stock: [{ locationId: other.id, stock: TEE_START_STOCK }],
      },
    ],
  });

  await insertCart(db, {
    accountId: account.id,
    token: CHECKOUT_CART_TOKEN,
    items: [
      { variantId: af1.id, quantity: AF1.quantity },
      { variantId: tee.id, quantity: TEE.quantity },
    ],
  });

  return {
    accountId: account.id,
    connectedAccountId: stripeAccount.stripeAccountId,
    cartToken: CHECKOUT_CART_TOKEN,
    shipFromLocationId: shipFrom.id,
    otherLocationId: other.id,
    variantWithOptions: af1.id,
    variantNoOptions: tee.id,
  };
}

// the subset of a Stripe.Checkout.Session the producer reads, for the seeded
// scenario. `checkout.session.completed` / `.async_payment_succeeded` carry
// this same shape.
export function checkoutSession(s: CheckoutScenario) {
  return {
    id: CHECKOUT_SESSION_ID,
    status: 'complete',
    payment_status: 'paid',
    payment_intent: CHECKOUT_PAYMENT_INTENT_ID,
    metadata: {
      accountId: String(s.accountId),
      cartToken: s.cartToken,
      shippingLocationId: String(s.shipFromLocationId),
    },
    collected_information: {
      shipping_details: { name: CUSTOMER.name, address: { ...SHIPPING_ADDRESS } },
    },
    customer_details: { email: CUSTOMER.email, name: CUSTOMER.name },
    amount_total: AMOUNT_TOTAL_CENTS,
    shipping_cost: { amount_total: SHIPPING_CENTS },
  };
}

// the checkout-completed job the producer must enqueue for `checkoutSession(s)`
// + the seeded cart. `items` are sorted by variantId (the producer's order
// follows the cart query, which has no ORDER BY — compare sorted).
export function canonicalOrderJobData(s: CheckoutScenario, correlationId = 'corr-e2e') {
  return {
    type: 'checkout-completed' as const,
    correlationId,
    accountId: s.accountId,
    cartToken: s.cartToken,
    stripeCheckoutSessionId: CHECKOUT_SESSION_ID,
    stripePaymentIntentId: CHECKOUT_PAYMENT_INTENT_ID,
    customerEmail: CUSTOMER.email,
    customerName: CUSTOMER.name,
    shippingLine1: SHIPPING_ADDRESS.line1,
    shippingLine2: SHIPPING_ADDRESS.line2,
    shippingCity: SHIPPING_ADDRESS.city,
    shippingState: SHIPPING_ADDRESS.state,
    shippingPostalCode: SHIPPING_ADDRESS.postal_code,
    shippingCountry: SHIPPING_ADDRESS.country,
    subtotalCents: SUBTOTAL_CENTS,
    amountTotalCents: AMOUNT_TOTAL_CENTS,
    shippingCents: SHIPPING_CENTS,
    shippingLocationId: s.shipFromLocationId,
    items: [
      {
        variantId: s.variantWithOptions,
        productName: PRODUCT_NAME,
        sku: AF1.sku,
        optionsLabel: 'Size: 8',
        priceCents: AF1.priceCents,
        quantity: AF1.quantity,
      },
      {
        variantId: s.variantNoOptions,
        productName: PRODUCT_NAME,
        sku: TEE.sku,
        optionsLabel: null,
        priceCents: TEE.priceCents,
        quantity: TEE.quantity,
      },
    ].sort((a, b) => a.variantId - b.variantId),
  };
}

const byVariant = <T extends { variantId: number | null }>(rows: T[]) =>
  [...rows].sort((a, b) => (a.variantId ?? 0) - (b.variantId ?? 0));

// asserts the full end state the consumer must produce from
// `canonicalOrderJobData(s)`: order + shipping + payment + items + one sold
// movement per line + decremented stock + deleted cart.
export async function assertCanonicalOrderWritten(
  db: TestDb,
  s: CheckoutScenario,
): Promise<void> {
  const [order] = await db
    .select()
    .from(ordersTable)
    .where(eq(ordersTable.accountId, s.accountId));
  expect(order).toMatchObject({
    channel: 'web',
    status: 'paid',
    customerEmail: CUSTOMER.email,
    customerName: CUSTOMER.name,
    subtotalCents: SUBTOTAL_CENTS,
    amountTotalCents: AMOUNT_TOTAL_CENTS,
    shippingCents: SHIPPING_CENTS,
  });

  const [shipping] = await db
    .select()
    .from(orderShippingTable)
    .where(eq(orderShippingTable.orderId, order.id));
  expect(shipping).toMatchObject({
    line1: SHIPPING_ADDRESS.line1,
    line2: SHIPPING_ADDRESS.line2,
    city: SHIPPING_ADDRESS.city,
    state: SHIPPING_ADDRESS.state,
    postalCode: SHIPPING_ADDRESS.postal_code,
    country: SHIPPING_ADDRESS.country,
    locationId: s.shipFromLocationId,
  });

  const [payment] = await db
    .select()
    .from(orderPaymentsTable)
    .where(eq(orderPaymentsTable.orderId, order.id));
  expect(payment).toMatchObject({
    method: 'stripe',
    amountCents: AMOUNT_TOTAL_CENTS,
    stripeCheckoutSessionId: CHECKOUT_SESSION_ID,
    stripePaymentIntentId: CHECKOUT_PAYMENT_INTENT_ID,
  });

  const items = byVariant(
    await db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, order.id)),
  );
  expect(items).toMatchObject([
    {
      variantId: s.variantWithOptions,
      productName: PRODUCT_NAME,
      sku: AF1.sku,
      optionsLabel: 'Size: 8',
      priceCents: AF1.priceCents,
      quantity: AF1.quantity,
      weightOz: AF1.weightOz,
    },
    {
      variantId: s.variantNoOptions,
      productName: PRODUCT_NAME,
      sku: TEE.sku,
      optionsLabel: null,
      priceCents: TEE.priceCents,
      quantity: TEE.quantity,
      weightOz: TEE.weightOz,
    },
  ]);

  const movements = byVariant(await db.select().from(inventoryMovementsTable));
  expect(movements).toMatchObject([
    {
      variantId: s.variantWithOptions,
      locationId: s.shipFromLocationId,
      delta: -AF1.quantity,
      reason: 'sold',
    },
    {
      variantId: s.variantNoOptions,
      locationId: s.otherLocationId,
      delta: -TEE.quantity,
      reason: 'sold',
    },
  ]);

  const [af1Stock] = await db
    .select()
    .from(inventoryTable)
    .where(
      and(
        eq(inventoryTable.variantId, s.variantWithOptions),
        eq(inventoryTable.locationId, s.shipFromLocationId),
      ),
    );
  expect(af1Stock.stock).toBe(AF1_START_STOCK - AF1.quantity);

  const [teeStock] = await db
    .select()
    .from(inventoryTable)
    .where(
      and(
        eq(inventoryTable.variantId, s.variantNoOptions),
        eq(inventoryTable.locationId, s.otherLocationId),
      ),
    );
  expect(teeStock.stock).toBe(TEE_START_STOCK - TEE.quantity);

  const carts = await db
    .select()
    .from(cartsTable)
    .where(eq(cartsTable.token, s.cartToken));
  expect(carts).toEqual([]);
}
