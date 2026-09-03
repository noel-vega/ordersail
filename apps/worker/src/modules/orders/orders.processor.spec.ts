import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import type { Job } from 'bullmq';
import { Logger } from 'logging';
import { QUEUE_NAMES, type OrderJobData } from 'queue';
import { makeWriteDb, firstCall } from 'test-support';
import { DRIZZLE } from '../../database/database.constants';
import { OrdersProcessor } from './orders.processor';

interface InvRow {
  locationId: number;
  stock: number;
}

interface Fx {
  idempotency?: { id: number; confirmationEmailQueuedAt: Date | null };
  orderId?: number;
  /** per-line variant weight, in `data.items` order */
  weights?: (number | null)[];
  /** per-line `order_items.id` returned by `.returning()`, in `data.items` order */
  orderItemIds?: number[];
  /** per-line inventory rows, already sorted highest-stock-first (as the real query returns) */
  inventoryRows?: InvRow[][];
  account?: { name: string };
  transactionThrows?: Error;
}

const BASE_DATA: OrderJobData = {
  type: 'checkout-completed',
  correlationId: 'corr-1',
  accountId: 1,
  cartToken: 'cart-tok',
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
  shippingLocationId: 7,
  storefrontUrl: 'http://localhost:3002',
  items: [
    {
      variantId: 10,
      productName: 'AF1',
      sku: 'AF1-8',
      optionsLabel: 'Size: 8',
      priceCents: 11500,
      quantity: 1,
    },
    {
      variantId: 11,
      productName: 'AJ1',
      sku: null,
      optionsLabel: null,
      priceCents: 11500,
      quantity: 1,
    },
  ],
};

// fixture that lets the happy-path transaction run to completion
const HAPPY: Fx = {
  weights: [32, null],
  orderItemIds: [201, 202],
  inventoryRows: [[{ locationId: 1, stock: 5 }], [{ locationId: 2, stock: 3 }]],
  account: { name: 'Depot' },
};

function job(data: Partial<OrderJobData> = {}): Job<OrderJobData> {
  return {
    id: '1',
    name: 'checkout-completed',
    opts: { attempts: 8 },
    attemptsMade: 0,
    data: { ...BASE_DATA, ...data },
  } as unknown as Job<OrderJobData>;
}

async function build(fx: Fx = {}) {
  const h = makeWriteDb({
    select: {
      order_payments: () => (fx.idempotency ? [fx.idempotency] : []),
      product_variants: (i: number) => [{ weightOz: fx.weights?.[i] ?? null }],
      inventory: (i: number) => fx.inventoryRows?.[i] ?? [],
      accounts: () => (fx.account ? [fx.account] : []),
    },
    returning: {
      orders: () => ({ id: fx.orderId ?? 100 }),
      order_items: (i: number) => ({ id: fx.orderItemIds?.[i] ?? 900 + i }),
    },
    transactionThrows: fx.transactionThrows,
  });
  const emailQueue = { add: jest.fn() };
  const ref: TestingModule = await Test.createTestingModule({
    providers: [
      OrdersProcessor,
      { provide: DRIZZLE, useValue: h.db },
      { provide: getQueueToken(QUEUE_NAMES.EMAIL), useValue: emailQueue },
    ],
  }).compile();
  return { processor: ref.get(OrdersProcessor), h, emailQueue };
}

describe('OrdersProcessor — checkout-completed', () => {
  it('writes the order, shipping and payment rows in one transaction', async () => {
    const { processor, h } = await build(HAPPY);

    await processor.process(job());

    expect(h.inserted('orders')).toEqual([
      {
        accountId: 1,
        channel: 'web',
        customerEmail: 'buyer@test.com',
        customerName: 'Buyer',
        subtotalCents: 23000,
        amountTotalCents: 23845,
        shippingCents: 845,
      },
    ]);
    expect(h.inserted('order_shipping')).toEqual([
      {
        orderId: 100,
        line1: '1 Main St',
        line2: null,
        city: 'SF',
        state: 'CA',
        postalCode: '94114',
        country: 'US',
        locationId: 7,
      },
    ]);
    expect(h.inserted('order_payments')).toEqual([
      {
        orderId: 100,
        method: 'stripe',
        amountCents: 23845,
        stripeCheckoutSessionId: 'cs_1',
        stripePaymentIntentId: 'pi_1',
      },
    ]);
  });

  it('snapshots each line into order_items with the variant weight', async () => {
    const { processor, h } = await build(HAPPY);

    await processor.process(job());

    expect(h.inserted('order_items')).toEqual([
      {
        orderId: 100,
        variantId: 10,
        productName: 'AF1',
        sku: 'AF1-8',
        optionsLabel: 'Size: 8',
        priceCents: 11500,
        quantity: 1,
        weightOz: 32,
      },
      {
        orderId: 100,
        variantId: 11,
        productName: 'AJ1',
        sku: null,
        optionsLabel: null,
        priceCents: 11500,
        quantity: 1,
        weightOz: null,
      },
    ]);
  });

  it('records one sold movement + inventory upsert per line and deletes the cart', async () => {
    const { processor, h } = await build(HAPPY);

    await processor.process(job());

    expect(h.inserted('inventory_movements')).toEqual([
      {
        orderItemId: 201,
        variantId: 10,
        locationId: 1,
        delta: -1,
        reason: 'sold',
      },
      {
        orderItemId: 202,
        variantId: 11,
        locationId: 2,
        delta: -1,
        reason: 'sold',
      },
    ]);
    expect(h.upserted('inventory')).toHaveLength(2);
    expect(h.upserted('inventory')[0].values).toEqual({
      variantId: 10,
      locationId: 1,
      stock: -1,
    });
    expect(h.deleted('carts')).toBe(1);
  });

  it('enqueues an order-confirmation email and stamps confirmationEmailQueuedAt', async () => {
    const { processor, h, emailQueue } = await build(HAPPY);

    await processor.process(job());

    expect(emailQueue.add).toHaveBeenCalledTimes(1);
    const [name, payload] = firstCall(emailQueue.add) as [
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe('order-confirmation');
    expect(firstCall(emailQueue.add)).toHaveLength(2); // no job-options arg
    expect(payload).toMatchObject({
      type: 'order-confirmation',
      to: 'buyer@test.com',
      customerName: 'Buyer',
      accountName: 'Depot',
      orderId: 100,
      correlationId: 'corr-1',
      subtotalCents: 23000,
      shippingCents: 845,
      amountTotalCents: 23845,
      shippingLine1: '1 Main St',
      shippingPostalCode: '94114',
      storefrontUrl: 'http://localhost:3002',
    });
    expect(payload.items).toEqual(BASE_DATA.items);
    const updates = h.updated('orders');
    expect(updates).toHaveLength(1);
    expect(
      (updates[0] as Record<string, unknown>).confirmationEmailQueuedAt,
    ).toBeInstanceOf(Date);
  });

  it('allocates stock greedily across locations, highest stock first', async () => {
    const { processor, h } = await build({
      weights: [32],
      orderItemIds: [201],
      inventoryRows: [
        [
          { locationId: 2, stock: 5 },
          { locationId: 1, stock: 4 },
        ],
      ],
      account: { name: 'Depot' },
    });

    await processor.process(
      job({
        items: [
          {
            variantId: 10,
            productName: 'AF1',
            sku: 'AF1-8',
            optionsLabel: 'Size: 8',
            priceCents: 11500,
            quantity: 7,
          },
        ],
      }),
    );

    expect(h.inserted('inventory_movements')).toEqual([
      {
        orderItemId: 201,
        variantId: 10,
        locationId: 2,
        delta: -5,
        reason: 'sold',
      },
      {
        orderItemId: 201,
        variantId: 10,
        locationId: 1,
        delta: -2,
        reason: 'sold',
      },
    ]);
  });

  it('records the shortfall against the top location when stock runs out', async () => {
    const { processor, h } = await build({
      weights: [32],
      orderItemIds: [201],
      inventoryRows: [[{ locationId: 1, stock: 2 }]],
      account: { name: 'Depot' },
    });

    await processor.process(
      job({
        items: [
          {
            variantId: 10,
            productName: 'AF1',
            sku: 'AF1-8',
            optionsLabel: 'Size: 8',
            priceCents: 11500,
            quantity: 5,
          },
        ],
      }),
    );

    expect(h.inserted('inventory_movements')).toEqual([
      {
        orderItemId: 201,
        variantId: 10,
        locationId: 1,
        delta: -2,
        reason: 'sold',
      },
      {
        orderItemId: 201,
        variantId: 10,
        locationId: 1,
        delta: -3,
        reason: 'sold',
      },
    ]);
  });

  it('creates the order but no movement when a variant has no inventory rows', async () => {
    const { processor, h, emailQueue } = await build({
      weights: [32],
      orderItemIds: [201],
      inventoryRows: [[]],
      account: { name: 'Depot' },
    });

    await processor.process(
      job({
        items: [
          {
            variantId: 10,
            productName: 'AF1',
            sku: 'AF1-8',
            optionsLabel: 'Size: 8',
            priceCents: 11500,
            quantity: 1,
          },
        ],
      }),
    );

    expect(h.inserted('inventory_movements')).toEqual([]);
    expect(h.inserted('order_items')).toHaveLength(1);
    expect(h.deleted('carts')).toBe(1);
    expect(emailQueue.add).toHaveBeenCalledTimes(1);
  });

  it('is a full no-op when the order already exists and its email was queued', async () => {
    const { processor, h, emailQueue } = await build({
      idempotency: { id: 55, confirmationEmailQueuedAt: new Date() },
    });

    await processor.process(job());

    expect(h.inserted('orders')).toEqual([]);
    expect(h.deleted('carts')).toBe(0);
    expect(emailQueue.add).not.toHaveBeenCalled();
  });

  it('re-enqueues only the confirmation email when the order exists but its email was not queued', async () => {
    const { processor, h, emailQueue } = await build({
      idempotency: { id: 55, confirmationEmailQueuedAt: null },
      account: { name: 'Shop' },
    });

    await processor.process(job());

    expect(h.inserted('orders')).toEqual([]);
    expect(emailQueue.add).toHaveBeenCalledTimes(1);
    const [, payload] = firstCall(emailQueue.add) as [
      string,
      Record<string, unknown>,
    ];
    expect(payload).toMatchObject({ orderId: 55, accountName: 'Shop' });
    const updates = h.updated('orders');
    expect(updates).toHaveLength(1);
    expect(
      (updates[0] as Record<string, unknown>).confirmationEmailQueuedAt,
    ).toBeInstanceOf(Date);
  });

  it('swallows an email-enqueue failure — the order is already committed', async () => {
    const errSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { processor, h, emailQueue } = await build(HAPPY);
    emailQueue.add.mockRejectedValue(new Error('redis down'));

    await expect(processor.process(job())).resolves.toBeUndefined();

    expect(h.updated('orders')).toEqual([]); // never reached the stamp
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to enqueue its confirmation email'),
    );
    errSpy.mockRestore();
  });

  it('lets a transaction failure propagate so BullMQ retries the job', async () => {
    const { processor, emailQueue } = await build({
      transactionThrows: new Error('db down'),
    });

    await expect(processor.process(job())).rejects.toThrow('db down');
    expect(emailQueue.add).not.toHaveBeenCalled();
  });
});

describe('OrdersProcessor.onFailed', () => {
  it('logs a permanent failure once retries are exhausted', async () => {
    const errSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { processor } = await build();

    processor.onFailed(
      {
        ...job(),
        attemptsMade: 8,
        opts: { attempts: 8 },
      } as unknown as Job<OrderJobData>,
      new Error('boom'),
    );

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed permanently'),
    );
    errSpy.mockRestore();
  });

  it('logs a retry warning while attempts remain', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { processor } = await build();

    processor.onFailed(
      {
        ...job(),
        attemptsMade: 2,
        opts: { attempts: 8 },
      } as unknown as Job<OrderJobData>,
      new Error('boom'),
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed on attempt 2/8'),
    );
    warnSpy.mockRestore();
  });
});
