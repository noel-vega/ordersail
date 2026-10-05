// Seeds ~90 days of paid web order history for the demo store, so the
// dashboard, the order pages, fulfillment views and customer order history
// don't start empty. Rows are written in the same shape the checkout worker
// (apps/worker/src/modules/orders/orders.processor.ts) and the manual
// fulfillment path (merchant-api sales/fulfillments) leave them.
//
// Deterministic (fixed-seed PRNG), but dates are relative to now, so the
// history always covers "the last 90 days" as of the run. Re-runnable: skipped
// entirely once the account has any order.
import {
  db,
  eq,
  asc,
  ordersTable,
  orderShippingTable,
  orderPaymentsTable,
  orderItemsTable,
  inventoryMovementsTable,
  fulfillmentsTable,
  fulfillmentItemsTable,
  productsTable,
  productVariantsTable,
  productOptionsTable,
  productOptionValuesTable,
  variantOptionValuesTable,
} from 'db';
import { createRng, type Rng } from './seed-random.js';
import { SHIP_TO_ADDRESSES, type SeededCustomer } from './seed-customers.js';

const HISTORY_DAYS = 90;
const TIMEZONE = 'America/Los_Angeles';
// orders newer than this are left unfulfilled — the "to ship" queue
const UNFULFILLED_WITHIN_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const SHIPPING_RATES_CENTS = [895, 1295, 2495] as const;
const CARRIERS = [
  { carrier: 'USPS', levels: ['Priority Mail', 'Ground Advantage'] },
  { carrier: 'UPS', levels: ['Ground'] },
] as const;

const GUEST_FIRST_NAMES = [
  'Jordan', 'Riley', 'Casey', 'Morgan', 'Alex', 'Taylor', 'Jamie', 'Quinn',
  'Drew', 'Avery', 'Rowan', 'Parker', 'Skyler', 'Reese', 'Blake', 'Sage',
] as const;
const GUEST_LAST_NAMES = [
  'Foster', 'Diaz', 'Park', 'Bailey', 'Ramos', 'Gray', 'Ward', 'Silva',
  'Hart', 'Kelly', 'Moreno', 'Lee', 'Burke', 'Cruz', 'Fox', 'Stone',
] as const;

interface CatalogVariant {
  variantId: number;
  productId: number;
  productName: string;
  sku: string | null;
  optionsLabel: string | null;
  priceCents: number;
  weightOz: number | null;
}

interface PlannedLine {
  variant: CatalogVariant;
  quantity: number;
}

// every active variant for the account, with its options label in the
// checkout snapshot format ("Size: 10")
async function loadCatalog(accountId: number): Promise<CatalogVariant[]> {
  const rows = await db
    .select({
      variantId: productVariantsTable.id,
      productId: productsTable.id,
      productName: productsTable.name,
      sku: productVariantsTable.sku,
      priceCents: productVariantsTable.priceCents,
      weightOz: productVariantsTable.weightOz,
      optionName: productOptionsTable.name,
      optionValue: productOptionValuesTable.value,
    })
    .from(productVariantsTable)
    .innerJoin(productsTable, eq(productsTable.id, productVariantsTable.productId))
    .leftJoin(variantOptionValuesTable, eq(variantOptionValuesTable.variantId, productVariantsTable.id))
    .leftJoin(productOptionValuesTable, eq(productOptionValuesTable.id, variantOptionValuesTable.optionValueId))
    .leftJoin(productOptionsTable, eq(productOptionsTable.id, productOptionValuesTable.optionId))
    .where(eq(productsTable.accountId, accountId))
    .orderBy(asc(productsTable.id), asc(productVariantsTable.id), asc(productOptionsTable.id));

  const byVariant = new Map<number, CatalogVariant & { options: string[] }>();
  for (const row of rows) {
    let variant = byVariant.get(row.variantId);
    if (!variant) {
      variant = { ...row, optionsLabel: null, options: [] };
      byVariant.set(row.variantId, variant);
    }
    if (row.optionName && row.optionValue) variant.options.push(`${row.optionName}: ${row.optionValue}`);
  }
  return [...byVariant.values()].map(({ options, ...v }) => ({
    ...v,
    optionsLabel: options.join(', ') || null,
  }));
}

// UTC offset of `timeZone` at `date`, in ms (negative west of UTC)
function tzOffsetMs(date: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// a wall-clock time in `timeZone` → the instant it names
function zonedTime(y: number, m: number, d: number, hour: number, minute: number, timeZone: string): Date {
  const guess = Date.UTC(y, m, d, hour, minute);
  return new Date(guess - tzOffsetMs(new Date(guess), timeZone));
}

function trackingNumber(rng: Rng, carrier: string): string {
  const digits = (n: number) => Array.from({ length: n }, () => rng.int(0, 9)).join('');
  if (carrier === 'UPS') {
    const alnum = '0123456789ABCDEFGHJKLMNPRSTUVWXYZ';
    return `1Z${Array.from({ length: 16 }, () => rng.pick([...alnum])).join('')}`;
  }
  return `9400${digits(18)}`;
}

export async function ensureOrderHistory(opts: {
  accountId: number;
  locationId: number;
  customers: SeededCustomer[];
  // when the restock movement covering the seeded sales is dated — before
  // the first order, alongside the opening stock
  restockAt: Date;
}): Promise<{ created: number; skipped: boolean }> {
  const { accountId, locationId, customers, restockAt } = opts;

  const [existing] = await db
    .select({ id: ordersTable.id })
    .from(ordersTable)
    .where(eq(ordersTable.accountId, accountId))
    .limit(1);
  if (existing) return { created: 0, skipped: true };

  const catalog = await loadCatalog(accountId);
  if (catalog.length === 0) return { created: 0, skipped: true };

  const rng = createRng(2);
  const now = new Date();

  // some products sell far better than others; mid sizes beat the edges
  const productIds = [...new Set(catalog.map((v) => v.productId))];
  const productWeights = productIds.map(() => 1 + rng.next() * 9);
  const variantsByProduct = new Map(
    productIds.map((id) => [id, catalog.filter((v) => v.productId === id)]),
  );
  const sizeWeight = (v: CatalogVariant) => (/: (9|10)$/.test(v.optionsLabel ?? '') ? 3 : 1);

  // a fifth of customers never order; the rest have a skewed appetite
  const customerWeights = customers.map(() => (rng.chance(0.2) ? 0 : 1 + rng.next() ** 2 * 5));

  // today's calendar date in the store's timezone
  const [ty, tm, td] = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE })
    .format(now)
    .split('-')
    .map(Number);

  let sequence = 0;
  const ordersByCustomer = customers.map(() => 0);
  const soldByVariant = new Map<number, number>();

  await db.transaction(async (tx) => {
    for (let daysAgo = HISTORY_DAYS - 1; daysAgo >= 0; daysAgo--) {
      const day = new Date(Date.UTC(ty, tm - 1, td - daysAgo));
      const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()];
      const weekend = day.getUTCDay() === 0 || day.getUTCDay() === 6;
      const progress = (HISTORY_DAYS - 1 - daysAgo) / (HISTORY_DAYS - 1);
      const mean = 3 + 2 * progress + (weekend ? 1.5 : 0);
      const count = Math.max(0, Math.round(mean + (rng.next() * 3 - 1.5)));

      const times = Array.from({ length: count }, () =>
        zonedTime(y, m, d, rng.int(8, 21), rng.int(0, 59), TIMEZONE),
      ).sort((a, b) => a.getTime() - b.getTime());

      for (const placedAt of times) {
        // the PRNG draws below run even for a skipped (future) slot, so the
        // sequence doesn't depend on what time of day the seed runs
        // only customers who'd signed up by then; damped by orders already
        // placed, or the earliest signups soak up every early registered order
        const eligible = customers.map((c, i) =>
          c.createdAt <= placedAt ? customerWeights[i] / (1 + ordersByCustomer[i]) : 0,
        );
        const registered =
          rng.chance(2 / 3) && eligible.some((w) => w > 0) ? rng.weighted(customers, eligible) : null;
        const guestFirst = rng.pick(GUEST_FIRST_NAMES);
        const guestLast = rng.pick(GUEST_LAST_NAMES);
        const guestEmail = `${guestFirst}.${guestLast}${rng.int(1, 99)}@example.net`.toLowerCase();
        const guestAddress = rng.pick(SHIP_TO_ADDRESSES);

        const lineCount = rng.weighted([1, 2, 3], [75, 20, 5]);
        const lines: PlannedLine[] = [];
        const usedProducts = new Set<number>();
        for (let i = 0; i < lineCount; i++) {
          const productId = rng.weighted(productIds, productWeights);
          const quantity = rng.weighted([1, 2], [90, 10]);
          if (usedProducts.has(productId)) continue;
          usedProducts.add(productId);
          const variants = variantsByProduct.get(productId)!;
          lines.push({ variant: rng.weighted(variants, variants.map(sizeWeight)), quantity });
        }

        const shippingCents = rng.pick(SHIPPING_RATES_CENTS);
        const partial = lines.length > 1 && rng.chance(0.05);
        const fulfilledAt = new Date(placedAt.getTime() + DAY_MS + rng.next() * DAY_MS);
        const { carrier, levels } = rng.pick(CARRIERS);
        const serviceLevel = rng.pick(levels);
        const tracking = trackingNumber(rng, carrier);
        const labelCents = rng.int(600, 1400);

        if (placedAt > now) continue;
        sequence++;
        if (registered) ordersByCustomer[customers.indexOf(registered)]++;

        const subtotalCents = lines.reduce((sum, l) => sum + l.variant.priceCents * l.quantity, 0);
        const address = registered?.address ?? guestAddress;

        const [order] = await tx
          .insert(ordersTable)
          .values({
            accountId,
            channel: 'web',
            status: 'paid',
            customerEmail: registered?.email ?? guestEmail,
            customerName: registered
              ? `${registered.firstname} ${registered.lastname}`
              : `${guestFirst} ${guestLast}`,
            customerId: registered?.id ?? null,
            subtotalCents,
            shippingCents,
            amountTotalCents: subtotalCents + shippingCents,
            confirmationEmailQueuedAt: placedAt,
            createdAt: placedAt,
            updatedAt: placedAt,
          })
          .returning({ id: ordersTable.id });

        await tx.insert(orderShippingTable).values({
          orderId: order.id,
          line1: address.line1,
          line2: address.line2,
          city: address.city,
          state: address.state,
          postalCode: address.postalCode,
          country: address.country,
          locationId,
          createdAt: placedAt,
        });

        // fake ids: a Stripe-backed refund/cancel on a seeded order will fail
        await tx.insert(orderPaymentsTable).values({
          orderId: order.id,
          method: 'stripe',
          amountCents: subtotalCents + shippingCents,
          stripeCheckoutSessionId: `cs_test_seed_${sequence}`,
          stripePaymentIntentId: `pi_test_seed_${sequence}`,
          createdAt: placedAt,
        });

        const orderItemIds: { id: number; quantity: number }[] = [];
        for (const { variant, quantity } of lines) {
          const [item] = await tx
            .insert(orderItemsTable)
            .values({
              orderId: order.id,
              variantId: variant.variantId,
              productName: variant.productName,
              sku: variant.sku,
              optionsLabel: variant.optionsLabel,
              priceCents: variant.priceCents,
              quantity,
              weightOz: variant.weightOz,
              createdAt: placedAt,
            })
            .returning({ id: orderItemsTable.id });
          orderItemIds.push({ id: item.id, quantity });

          await tx.insert(inventoryMovementsTable).values({
            orderItemId: item.id,
            variantId: variant.variantId,
            locationId,
            delta: -quantity,
            reason: 'sold',
            createdAt: placedAt,
          });
          soldByVariant.set(variant.variantId, (soldByVariant.get(variant.variantId) ?? 0) + quantity);
        }

        const ageMs = now.getTime() - placedAt.getTime();
        if (ageMs <= UNFULFILLED_WITHIN_DAYS * DAY_MS) continue;

        const [fulfillment] = await tx
          .insert(fulfillmentsTable)
          .values({
            orderId: order.id,
            locationId,
            trackingNumber: tracking,
            shippingCarrier: carrier,
            shippingServiceLevel: serviceLevel,
            amountCents: labelCents,
            createdAt: fulfilledAt,
            updatedAt: fulfilledAt,
          })
          .returning({ id: fulfillmentsTable.id });
        await tx.insert(fulfillmentItemsTable).values(
          (partial ? orderItemIds.slice(0, 1) : orderItemIds).map((item) => ({
            fulfillmentId: fulfillment.id,
            orderItemId: item.id,
            quantity: item.quantity,
            createdAt: fulfilledAt,
          })),
        );
      }
    }

    // inventory.stock is left alone: one back-dated restock per sold variant
    // offsets the sold movements, so the balance still ends at the configured
    // stock and the ledger still sums to it — and never dips below zero
    if (soldByVariant.size > 0) {
      await tx.insert(inventoryMovementsTable).values(
        [...soldByVariant].map(([variantId, quantity]) => ({
          variantId,
          locationId,
          delta: quantity,
          reason: 'received' as const,
          note: 'Seed: restock for demo sales',
          createdAt: restockAt,
        })),
      );
    }
  });

  return { created: sequence, skipped: false };
}
