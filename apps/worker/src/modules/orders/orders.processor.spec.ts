import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import type { Job } from 'bullmq';
import {
  cartsTable,
  desc,
  eq,
  failedOrdersTable,
  inventoryMovementsTable,
  inventoryTable,
  orderItemsTable,
  orderPaymentsTable,
  orderShippingTable,
  ordersTable,
} from 'db';
import { Logger } from 'logging';
import { QUEUE_NAMES, type OrderJobData } from 'queue';
import {
  insertAccount,
  insertCart,
  insertCustomer,
  insertLocation,
  insertOrder,
  insertOrderPayment,
  insertProductWithVariants,
  useTestDb,
  type TestDb,
} from 'test-support';
import { DRIZZLE } from '../../database/database.constants';
import { AlertsService, type CriticalAlert } from '../alerts/alerts.service';
import { OrdersProcessor } from './orders.processor';

const db = useTestDb();

async function build() {
  const emailQueue = { add: jest.fn() };
  const alerts = { publishCritical: jest.fn(), enabled: false };
  const ref: TestingModule = await Test.createTestingModule({
    providers: [
      OrdersProcessor,
      { provide: DRIZZLE, useValue: db },
      { provide: getQueueToken(QUEUE_NAMES.EMAIL), useValue: emailQueue },
      { provide: AlertsService, useValue: alerts },
    ],
  }).compile();
  return { processor: ref.get(OrdersProcessor), emailQueue, alerts };
}

interface Scenario {
  accountId: number;
  locationA: number;
  locationB: number;
  variantAf1: number;
  variantAj1: number;
  cartToken: string;
}

// account + two locations + a two-variant product (weights 32 / null) +
// per-location inventory + a cart to be deleted. Mirrors the old HAPPY
// fixture: AF1 stock lives only at location A, AJ1 only at location B.
async function seedScenario(
  over: {
    af1Stock?: { locationId: 'A' | 'B'; stock: number }[];
    aj1Stock?: { locationId: 'A' | 'B'; stock: number }[];
    af1Weight?: number | null;
  } = {},
): Promise<Scenario> {
  const account = await insertAccount(db);
  const locationA = await insertLocation(db, { accountId: account.id });
  const locationB = await insertLocation(db, { accountId: account.id });
  const loc = (id: 'A' | 'B') => (id === 'A' ? locationA.id : locationB.id);

  const [af1, aj1] = await insertProductWithVariants(db, {
    accountId: account.id,
    productName: 'Sneakers',
    variants: [
      {
        priceCents: 11500,
        sku: 'AF1-8',
        weightOz: over.af1Weight === undefined ? 32 : over.af1Weight,
        stock: (over.af1Stock ?? [{ locationId: 'A', stock: 5 }]).map((s) => ({
          locationId: loc(s.locationId),
          stock: s.stock,
        })),
      },
      {
        priceCents: 11500,
        sku: null,
        weightOz: null,
        stock: (over.aj1Stock ?? [{ locationId: 'B', stock: 3 }]).map((s) => ({
          locationId: loc(s.locationId),
          stock: s.stock,
        })),
      },
    ],
  });

  const cart = await insertCart(db, { accountId: account.id });

  return {
    accountId: account.id,
    locationA: locationA.id,
    locationB: locationB.id,
    variantAf1: af1.id,
    variantAj1: aj1.id,
    cartToken: cart.token,
  };
}

function job(s: Scenario, over: Partial<OrderJobData> = {}): Job<OrderJobData> {
  const data: OrderJobData = {
    type: 'checkout-completed',
    correlationId: 'corr-1',
    accountId: s.accountId,
    cartToken: s.cartToken,
    stripeCheckoutSessionId: 'cs_1',
    stripePaymentIntentId: 'pi_1',
    customerEmail: 'buyer@test.com',
    customerName: 'Buyer',
    shippingLine1: '1 Main St',
    shippingLine2: null,
    shippingCity: 'SF',
    shippingState: 'CA',
    shippingPostalCode: '94114',
    shippingCountry: 'US',
    subtotalCents: 23000,
    amountTotalCents: 23845,
    shippingCents: 845,
    shippingLocationId: s.locationA,
    storefrontUrl: 'http://localhost:3002',
    items: [
      {
        variantId: s.variantAf1,
        productName: 'AF1',
        sku: 'AF1-8',
        optionsLabel: 'Size: 8',
        priceCents: 11500,
        quantity: 1,
      },
      {
        variantId: s.variantAj1,
        productName: 'AJ1',
        sku: null,
        optionsLabel: null,
        priceCents: 11500,
        quantity: 1,
      },
    ],
    ...over,
  };
  return {
    id: '1',
    name: 'checkout-completed',
    opts: { attempts: 8 },
    attemptsMade: 0,
    data,
  } as unknown as Job<OrderJobData>;
}

const rowsFor = {
  orders: (t: TestDb, accountId: number) =>
    t.select().from(ordersTable).where(eq(ordersTable.accountId, accountId)),
  movements: (t: TestDb, variantId: number) =>
    t
      .select()
      .from(inventoryMovementsTable)
      .where(eq(inventoryMovementsTable.variantId, variantId))
      .orderBy(inventoryMovementsTable.id),
  stock: async (t: TestDb, variantId: number) =>
    t
      .select({
        locationId: inventoryTable.locationId,
        stock: inventoryTable.stock,
      })
      .from(inventoryTable)
      .where(eq(inventoryTable.variantId, variantId))
      .orderBy(desc(inventoryTable.stock)),
};

describe('OrdersProcessor — checkout-completed', () => {
  it('writes the order, shipping and payment rows in one transaction', async () => {
    const s = await seedScenario();
    const { processor } = await build();

    await processor.process(job(s));

    const [order] = await rowsFor.orders(db, s.accountId);
    expect(order).toMatchObject({
      accountId: s.accountId,
      channel: 'web',
      customerEmail: 'buyer@test.com',
      customerName: 'Buyer',
      subtotalCents: 23000,
      amountTotalCents: 23845,
      shippingCents: 845,
    });

    const [shipping] = await db
      .select()
      .from(orderShippingTable)
      .where(eq(orderShippingTable.orderId, order.id));
    expect(shipping).toMatchObject({
      line1: '1 Main St',
      line2: null,
      city: 'SF',
      state: 'CA',
      postalCode: '94114',
      country: 'US',
      locationId: s.locationA,
    });

    const [payment] = await db
      .select()
      .from(orderPaymentsTable)
      .where(eq(orderPaymentsTable.orderId, order.id));
    expect(payment).toMatchObject({
      method: 'stripe',
      amountCents: 23845,
      stripeCheckoutSessionId: 'cs_1',
      stripePaymentIntentId: 'pi_1',
    });
  });

  // OS-189
  it('links the order to a registered customer by email match', async () => {
    const s = await seedScenario();
    const customer = await insertCustomer(db, {
      accountId: s.accountId,
      email: 'buyer@test.com',
    });
    const { processor } = await build();

    await processor.process(job(s));

    const [order] = await rowsFor.orders(db, s.accountId);
    expect(order.customerId).toBe(customer.id);
  });

  // OS-189
  it('leaves customerId null for a guest checkout (no matching customer)', async () => {
    const s = await seedScenario();
    const { processor } = await build();

    await processor.process(job(s));

    const [order] = await rowsFor.orders(db, s.accountId);
    expect(order.customerId).toBeNull();
  });

  it('snapshots each line into order_items with the variant weight', async () => {
    const s = await seedScenario();
    const { processor } = await build();

    await processor.process(job(s));

    const items = await db
      .select()
      .from(orderItemsTable)
      .orderBy(orderItemsTable.id);
    expect(items).toMatchObject([
      {
        variantId: s.variantAf1,
        productName: 'AF1',
        sku: 'AF1-8',
        optionsLabel: 'Size: 8',
        priceCents: 11500,
        quantity: 1,
        weightOz: 32,
      },
      {
        variantId: s.variantAj1,
        productName: 'AJ1',
        sku: null,
        optionsLabel: null,
        priceCents: 11500,
        quantity: 1,
        weightOz: null,
      },
    ]);
  });

  it('records one sold movement per line, decrements inventory and deletes the cart', async () => {
    const s = await seedScenario();
    const { processor } = await build();

    await processor.process(job(s));

    const af1Moves = await rowsFor.movements(db, s.variantAf1);
    expect(af1Moves).toMatchObject([
      { locationId: s.locationA, delta: -1, reason: 'sold' },
    ]);
    const aj1Moves = await rowsFor.movements(db, s.variantAj1);
    expect(aj1Moves).toMatchObject([
      { locationId: s.locationB, delta: -1, reason: 'sold' },
    ]);

    expect(await rowsFor.stock(db, s.variantAf1)).toEqual([
      { locationId: s.locationA, stock: 4 },
    ]);
    expect(await rowsFor.stock(db, s.variantAj1)).toEqual([
      { locationId: s.locationB, stock: 2 },
    ]);

    const carts = await db
      .select()
      .from(cartsTable)
      .where(eq(cartsTable.token, s.cartToken));
    expect(carts).toEqual([]);
  });

  it('enqueues an order-confirmation email and stamps confirmationEmailQueuedAt', async () => {
    const s = await seedScenario();
    const { processor, emailQueue } = await build();

    await processor.process(job(s));

    expect(emailQueue.add).toHaveBeenCalledTimes(1);
    const [name, payload] = emailQueue.add.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe('order-confirmation');
    expect(emailQueue.add.mock.calls[0]).toHaveLength(2); // no job-options arg
    const [order] = await rowsFor.orders(db, s.accountId);
    expect(payload).toMatchObject({
      type: 'order-confirmation',
      to: 'buyer@test.com',
      customerName: 'Buyer',
      accountName: 'Test Store',
      orderId: order.id,
      correlationId: 'corr-1',
      subtotalCents: 23000,
      shippingCents: 845,
      amountTotalCents: 23845,
      shippingLine1: '1 Main St',
      shippingPostalCode: '94114',
      storefrontUrl: 'http://localhost:3002',
    });
    expect(payload.items).toEqual(job(s).data.items);
    expect(order.confirmationEmailQueuedAt).toBeInstanceOf(Date);
  });

  it('allocates stock greedily across locations, highest stock first', async () => {
    const s = await seedScenario({
      af1Stock: [
        { locationId: 'B', stock: 5 },
        { locationId: 'A', stock: 4 },
      ],
    });
    const { processor } = await build();

    await processor.process(
      job(s, {
        items: [
          {
            variantId: s.variantAf1,
            productName: 'AF1',
            sku: 'AF1-8',
            optionsLabel: 'Size: 8',
            priceCents: 11500,
            quantity: 7,
          },
        ],
      }),
    );

    expect(await rowsFor.movements(db, s.variantAf1)).toMatchObject([
      { locationId: s.locationB, delta: -5, reason: 'sold' },
      { locationId: s.locationA, delta: -2, reason: 'sold' },
    ]);
    expect(await rowsFor.stock(db, s.variantAf1)).toEqual([
      { locationId: s.locationA, stock: 2 },
      { locationId: s.locationB, stock: 0 },
    ]);
  });

  it('records the shortfall against the top location when stock runs out', async () => {
    const s = await seedScenario({ af1Stock: [{ locationId: 'A', stock: 2 }] });
    const { processor } = await build();

    await processor.process(
      job(s, {
        items: [
          {
            variantId: s.variantAf1,
            productName: 'AF1',
            sku: 'AF1-8',
            optionsLabel: 'Size: 8',
            priceCents: 11500,
            quantity: 5,
          },
        ],
      }),
    );

    expect(await rowsFor.movements(db, s.variantAf1)).toMatchObject([
      { locationId: s.locationA, delta: -2, reason: 'sold' },
      { locationId: s.locationA, delta: -3, reason: 'sold' },
    ]);
    // 2 - 2 - 3 — allowed to go negative, the payment already succeeded
    expect(await rowsFor.stock(db, s.variantAf1)).toEqual([
      { locationId: s.locationA, stock: -3 },
    ]);
  });

  it('creates the order but no movement when a variant has no inventory rows', async () => {
    const s = await seedScenario({ af1Stock: [] });
    const { processor, emailQueue } = await build();

    await processor.process(
      job(s, {
        items: [
          {
            variantId: s.variantAf1,
            productName: 'AF1',
            sku: 'AF1-8',
            optionsLabel: 'Size: 8',
            priceCents: 11500,
            quantity: 1,
          },
        ],
      }),
    );

    expect(await rowsFor.movements(db, s.variantAf1)).toEqual([]);
    expect(
      await db.select().from(orderItemsTable).orderBy(orderItemsTable.id),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(cartsTable)
        .where(eq(cartsTable.token, s.cartToken)),
    ).toEqual([]);
    expect(emailQueue.add).toHaveBeenCalledTimes(1);
  });

  it('is a full no-op when the order already exists and its email was queued', async () => {
    const s = await seedScenario();
    const order = await insertOrder(db, {
      accountId: s.accountId,
      confirmationEmailQueuedAt: new Date(),
    });
    await insertOrderPayment(db, {
      orderId: order.id,
      stripeCheckoutSessionId: 'cs_1',
    });
    const { processor, emailQueue } = await build();

    await processor.process(job(s));

    expect(await rowsFor.orders(db, s.accountId)).toHaveLength(1);
    expect(
      await db
        .select()
        .from(cartsTable)
        .where(eq(cartsTable.token, s.cartToken)),
    ).toHaveLength(1);
    expect(emailQueue.add).not.toHaveBeenCalled();
  });

  it('re-enqueues only the confirmation email when the order exists but its email was not queued', async () => {
    const s = await seedScenario();
    const order = await insertOrder(db, {
      accountId: s.accountId,
      confirmationEmailQueuedAt: null,
    });
    await insertOrderPayment(db, {
      orderId: order.id,
      stripeCheckoutSessionId: 'cs_1',
    });
    const { processor, emailQueue } = await build();

    await processor.process(job(s));

    expect(await rowsFor.orders(db, s.accountId)).toHaveLength(1);
    expect(emailQueue.add).toHaveBeenCalledTimes(1);
    const [, payload] = emailQueue.add.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(payload).toMatchObject({
      orderId: order.id,
      accountName: 'Test Store',
    });
    const [reloaded] = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.id, order.id));
    expect(reloaded.confirmationEmailQueuedAt).toBeInstanceOf(Date);
  });

  it('swallows an email-enqueue failure — the order is already committed', async () => {
    const errSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const s = await seedScenario();
    const { processor, emailQueue } = await build();
    emailQueue.add.mockRejectedValue(new Error('redis down'));

    await expect(processor.process(job(s))).resolves.toBeUndefined();

    const [order] = await rowsFor.orders(db, s.accountId);
    expect(order).toBeDefined(); // committed
    expect(order.confirmationEmailQueuedAt).toBeNull(); // never reached the stamp
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to enqueue its confirmation email'),
    );
    errSpy.mockRestore();
  });

  it('rolls the whole order back when a line hits a constraint, and rethrows', async () => {
    const s = await seedScenario();
    const { processor, emailQueue } = await build();

    await expect(
      processor.process(
        job(s, {
          items: [
            {
              variantId: 999_999, // no such variant — FK violation on order_items
              productName: 'Ghost',
              sku: null,
              optionsLabel: null,
              priceCents: 100,
              quantity: 1,
            },
          ],
        }),
      ),
    ).rejects.toThrow();

    expect(await rowsFor.orders(db, s.accountId)).toEqual([]);
    expect(await db.select().from(orderPaymentsTable)).toEqual([]);
    expect(emailQueue.add).not.toHaveBeenCalled();
  });
});

// a fully-formed job for the given scenario, with the attempt counters set
function jobAt(
  s: Scenario,
  attemptsMade: number,
  over: Partial<OrderJobData> = {},
): Job<OrderJobData> {
  return {
    ...(job(s, over) as unknown as Record<string, unknown>),
    id: 'j-1',
    attemptsMade,
    opts: { attempts: 8 },
  } as unknown as Job<OrderJobData>;
}

describe('OrdersProcessor.onFailed', () => {
  it('logs a retry warning while attempts remain, and writes no row', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const s = await seedScenario();
    const { processor, alerts } = await build();

    await processor.onFailed(jobAt(s, 2), new Error('boom'));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed on attempt 2/8'),
    );
    expect(await db.select().from(failedOrdersTable)).toEqual([]);
    expect(alerts.publishCritical).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('records a failed_orders row and an [alert] line once retries are exhausted', async () => {
    const errSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const s = await seedScenario();
    const { processor, alerts } = await build();
    const j = jobAt(s, 8);

    await processor.onFailed(j, new Error('db exploded'));

    const [[alert]] = alerts.publishCritical.mock.calls as CriticalAlert[][];
    expect(alert.subject).toContain(j.data.stripeCheckoutSessionId);
    expect(alert.message).toContain('A customer has paid and has no order');

    const [row] = await db.select().from(failedOrdersTable);
    expect(row).toMatchObject({
      stripeCheckoutSessionId: j.data.stripeCheckoutSessionId,
      stripePaymentIntentId: j.data.stripePaymentIntentId,
      accountId: s.accountId,
      jobId: 'j-1',
      errorMessage: 'db exploded',
      attempts: 8,
      resolvedAt: null,
      resolvedBy: null,
    });
    expect(row.payload).toMatchObject({ type: 'checkout-completed' });
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[alert].*1 unresolved failed order/s),
    );
    errSpy.mockRestore();
  });

  it('upserts on the checkout session — a re-failed replay updates, not duplicates', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const s = await seedScenario();
    const { processor } = await build();

    await processor.onFailed(jobAt(s, 8), new Error('first failure'));
    await processor.onFailed(jobAt(s, 8), new Error('second failure'));

    const rows = await db.select().from(failedOrdersTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].errorMessage).toBe('second failure');
  });

  it('never throws when writing the row itself fails', async () => {
    const errSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { processor, alerts } = await build();
    // accountId 999999 → FK violation on the failed_orders insert
    const j = jobAt({ ...(await seedScenario()), accountId: 999_999 }, 8);

    await expect(
      processor.onFailed(j, new Error('boom')),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('recording the failed_orders row failed'),
    );
    // a failed row write makes the page more urgent, not less
    const [[alert]] = alerts.publishCritical.mock.calls as CriticalAlert[][];
    expect(alert.message).toContain('failed_orders write also failed');
    errSpy.mockRestore();
  });

  it('logs a plain permanent-failure line for a non-checkout job type', async () => {
    const errSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { processor, alerts } = await build();

    await processor.onFailed(
      {
        data: { type: 'something-else', correlationId: 'c' },
        id: '1',
        name: 'x',
        attemptsMade: 8,
        opts: { attempts: 8 },
      } as unknown as Job<OrderJobData>,
      new Error('boom'),
    );

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed permanently'),
    );
    expect(await db.select().from(failedOrdersTable)).toEqual([]);
    expect(alerts.publishCritical).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('OrdersProcessor.onCompleted', () => {
  it('resolves a matching failed_orders row (a replay finally succeeded)', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const s = await seedScenario();
    const { processor } = await build();
    const j = jobAt(s, 8);

    await processor.onFailed(j, new Error('boom')); // creates the row
    await processor.onCompleted(j); // the replay succeeds

    const [row] = await db.select().from(failedOrdersTable);
    expect(row.resolvedBy).toBe('worker');
    expect(row.resolvedAt).toBeInstanceOf(Date);
  });

  it('is a no-op for a normal first-time order (no row to resolve)', async () => {
    const s = await seedScenario();
    const { processor } = await build();

    await expect(processor.onCompleted(jobAt(s, 0))).resolves.toBeUndefined();
    expect(await db.select().from(failedOrdersTable)).toEqual([]);
  });

  it('does not touch an already-resolved row on a later completion', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const s = await seedScenario();
    const { processor } = await build();
    const j = jobAt(s, 8);
    await processor.onFailed(j, new Error('boom'));
    await processor.onCompleted(j);
    const [afterFirst] = await db.select().from(failedOrdersTable);

    await processor.onCompleted(j);
    const [afterSecond] = await db.select().from(failedOrdersTable);

    // the `resolvedAt IS NULL` guard means the second completion matches nothing
    expect(afterSecond.resolvedAt).toEqual(afterFirst.resolvedAt);
  });
});
