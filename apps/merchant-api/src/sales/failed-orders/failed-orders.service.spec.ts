import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { OrderJobData } from 'queue';
import {
  insertAccount,
  insertOrder,
  insertOrderPayment,
  useTestDb,
} from 'test-support';
import { eq, failedOrdersTable } from 'db/sales';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { CheckoutOrderService } from '../checkout-orders/checkout-order.service';
import { FailedOrdersService } from './failed-orders.service';

const db = useTestDb();

function payload(over: Partial<OrderJobData> = {}): OrderJobData {
  return {
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
    subtotalCents: 5000,
    amountTotalCents: 5500,
    shippingCents: 500,
    shippingLocationId: null,
    items: [
      {
        variantId: 1,
        productName: 'Sneakers',
        sku: 'AF1-8',
        optionsLabel: 'Size: 8',
        priceCents: 2500,
        quantity: 2,
      },
    ],
    ...over,
  };
}

async function insertFailedOrder(opts: {
  accountId: number;
  sessionId?: string;
  resolvedAt?: Date | null;
  resolvedBy?: string | null;
}) {
  const p = payload({
    accountId: opts.accountId,
    stripeCheckoutSessionId: opts.sessionId ?? 'cs_1',
  });
  const [row] = await db
    .insert(failedOrdersTable)
    .values({
      stripeCheckoutSessionId: p.stripeCheckoutSessionId,
      stripePaymentIntentId: p.stripePaymentIntentId,
      accountId: opts.accountId,
      jobId: 'j-1',
      payload: p,
      errorMessage: 'db exploded',
      attempts: 8,
      resolvedAt: opts.resolvedAt ?? null,
      resolvedBy: opts.resolvedBy ?? null,
    })
    .returning();
  return row;
}

async function build() {
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const ref: TestingModule = await Test.createTestingModule({
    providers: [
      FailedOrdersService,
      { provide: DRIZZLE, useValue: db },
      { provide: CheckoutOrderService, useValue: { enqueue } },
    ],
  }).compile();
  return { service: ref.get(FailedOrdersService), enqueue };
}

describe('FailedOrdersService.list', () => {
  it("returns this account's rows newest-first with the unresolved count", async () => {
    const a = await insertAccount(db);
    const other = await insertAccount(db);
    await insertFailedOrder({ accountId: a.id, sessionId: 'cs_a1' });
    await insertFailedOrder({
      accountId: a.id,
      sessionId: 'cs_a2',
      resolvedAt: new Date(),
      resolvedBy: 'worker',
    });
    await insertFailedOrder({ accountId: other.id, sessionId: 'cs_b1' });

    const { service } = await build();
    const result = await service.list(a.id);

    expect(result.items).toHaveLength(2);
    expect(result.unresolvedCount).toBe(1);
    expect(result.items[0]).toMatchObject({
      stripeCheckoutSessionId: 'cs_a2',
      customerEmail: 'buyer@test.com',
      itemCount: 2,
      amountTotalCents: 5500,
      resolvedBy: 'worker',
    });
  });

  it('is empty for an account with no failures', async () => {
    const a = await insertAccount(db);
    const { service } = await build();

    await expect(service.list(a.id)).resolves.toEqual({
      items: [],
      unresolvedCount: 0,
    });
  });
});

describe('FailedOrdersService.retry', () => {
  it("404s for an unknown id or another account's row", async () => {
    const a = await insertAccount(db);
    const other = await insertAccount(db);
    const row = await insertFailedOrder({ accountId: other.id });
    const { service, enqueue } = await build();

    await expect(service.retry(999999, a.id, 1)).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.retry(row.id, a.id, 1)).rejects.toThrow(
      NotFoundException,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns an already-resolved row unchanged, without re-enqueueing', async () => {
    const a = await insertAccount(db);
    const resolvedAt = new Date('2026-09-01T00:00:00Z');
    const row = await insertFailedOrder({
      accountId: a.id,
      resolvedAt,
      resolvedBy: 'worker',
    });
    const { service, enqueue } = await build();

    const result = await service.retry(row.id, a.id, 7);

    expect(result.resolvedAt).toEqual(resolvedAt);
    expect(result.resolvedBy).toBe('worker');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('resolves the row itself when the order already exists', async () => {
    const a = await insertAccount(db);
    const row = await insertFailedOrder({ accountId: a.id, sessionId: 'cs_x' });
    const order = await insertOrder(db, { accountId: a.id });
    await insertOrderPayment(db, {
      orderId: order.id,
      stripeCheckoutSessionId: 'cs_x',
    });
    const { service, enqueue } = await build();

    const result = await service.retry(row.id, a.id, 7);

    expect(result.resolvedBy).toBe('staff:7');
    expect(result.resolvedAt).toBeInstanceOf(Date);
    expect(enqueue).not.toHaveBeenCalled();
    const [persisted] = await db
      .select()
      .from(failedOrdersTable)
      .where(eq(failedOrdersTable.id, row.id));
    expect(persisted.resolvedBy).toBe('staff:7');
  });

  it('re-enqueues the stored payload and leaves the row unresolved', async () => {
    const a = await insertAccount(db);
    const row = await insertFailedOrder({ accountId: a.id, sessionId: 'cs_y' });
    const { service, enqueue } = await build();

    const result = await service.retry(row.id, a.id, 7);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'checkout-completed',
        stripeCheckoutSessionId: 'cs_y',
      }),
    );
    expect(result.resolvedAt).toBeNull();
  });
});
