import { Test } from '@nestjs/testing';
import { orderEventsTable, orderRefundLinesTable } from 'db/sales';
import {
  insertAccount,
  insertOrder,
  insertOrderItem,
  insertOrderPayment,
  insertUser,
  useTestDb,
} from 'test-support';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { OrdersService } from './orders.service';

const db = useTestDb();

async function build() {
  const ref = await Test.createTestingModule({
    providers: [OrdersService, { provide: DRIZZLE, useValue: db }],
  }).compile();
  return ref.get(OrdersService);
}

describe('OrdersService — status + events (OS-120)', () => {
  it('findAll includes each order status', async () => {
    const account = await insertAccount(db);
    await insertOrder(db, { accountId: account.id, status: 'paid' });
    await insertOrder(db, { accountId: account.id, status: 'canceled' });
    const service = await build();

    const { items } = await service.findAll(20, 0, account.id);

    expect(items.map((o) => o.status).sort()).toEqual(['canceled', 'paid']);
  });

  it('findOne returns status, refund fields on payments, and the events trail newest-first', async () => {
    const account = await insertAccount(db);
    const staff = await insertUser(db, {
      accountId: account.id,
      firstname: 'Dana',
      lastname: 'Scully',
    });
    const order = await insertOrder(db, {
      accountId: account.id,
      status: 'partially_refunded',
    });
    await insertOrderItem(db, { orderId: order.id, quantity: 1 });
    await insertOrderPayment(db, {
      orderId: order.id,
      method: 'stripe',
      amountCents: 5000,
      stripePaymentIntentId: 'pi_1',
    });
    // a refund row
    await db.insert(orderEventsTable).values([
      {
        orderId: order.id,
        type: 'status_changed',
        message: 'Status changed from paid to partially_refunded',
        actorType: 'staff',
        actorUserId: staff.id,
        createdAt: new Date('2026-01-01T10:00:00Z'),
      },
      {
        orderId: order.id,
        type: 'refund',
        message: 'Refunded $20.00',
        actorType: 'system',
        actorUserId: null,
        createdAt: new Date('2026-01-01T11:00:00Z'),
      },
    ]);
    const service = await build();

    const detail = await service.findOne(order.id, account.id);

    expect(detail?.status).toBe('partially_refunded');
    expect(detail?.payments[0]).toMatchObject({
      method: 'stripe',
      stripeRefundId: null,
      reason: null,
    });

    expect(detail?.events).toEqual([
      expect.objectContaining({
        type: 'refund',
        message: 'Refunded $20.00',
        actorType: 'system',
        actorName: null,
      }),
      expect.objectContaining({
        type: 'status_changed',
        actorType: 'staff',
        actorName: 'Dana Scully',
      }),
    ]);
  });

  it('findOne returns an empty events array for a fresh order', async () => {
    const account = await insertAccount(db);
    const order = await insertOrder(db, { accountId: account.id });
    const service = await build();

    const detail = await service.findOne(order.id, account.id);
    expect(detail?.events).toEqual([]);
  });

  it('findOne reports refundedQuantity per item from order_refund_lines', async () => {
    const account = await insertAccount(db);
    const order = await insertOrder(db, { accountId: account.id });
    const item = await insertOrderItem(db, { orderId: order.id, quantity: 3 });
    const refund = await insertOrderPayment(db, {
      orderId: order.id,
      method: 'stripe',
      amountCents: -5000,
    });
    await db.insert(orderRefundLinesTable).values({
      refundPaymentId: refund.id,
      orderItemId: item.id,
      quantity: 1,
    });
    const service = await build();

    const detail = await service.findOne(order.id, account.id);
    expect(detail?.items[0]).toMatchObject({
      quantity: 3,
      refundedQuantity: 1,
    });
  });
});
