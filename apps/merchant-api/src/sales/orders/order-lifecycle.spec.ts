import { ConflictException } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { Logger } from 'logging';
import {
  eq,
  orderEventsTable,
  orderPaymentsTable,
  ordersTable,
} from 'db/sales';
import { inventoryTable } from 'db/stock';
import {
  insertOrder,
  insertUser,
  seedPaidWebOrder,
  useTestDb,
} from 'test-support';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { DOMAIN_EVENTS, DomainEventBus } from 'src/shared/events';
import { RefundsService } from './refunds.service';
import { CancelService } from './cancel.service';
import { DisputesService } from './disputes.service';
import { ChargeEventsHandler } from './charge-events.handler';
import { PAYMENTS_PORT } from './ports/payments.port';
import {
  ALLOWED_TRANSITIONS,
  ORDER_STATUSES,
  transitionOrderStatus,
} from './order-status';

const db = useTestDb();

// the sales-context order-lifecycle providers wired the way app.module wires
// them — a real DomainEventBus so the @OnDomainEvent handlers actually fire,
// the payments port mocked at the boundary.
async function build(
  refundPaymentIntent: jest.Mock = jest
    .fn()
    .mockResolvedValue({ stripeRefundId: 're_default' }),
) {
  const ref = await Test.createTestingModule({
    imports: [EventEmitterModule.forRoot()],
    providers: [
      RefundsService,
      CancelService,
      DisputesService,
      ChargeEventsHandler,
      DomainEventBus,
      { provide: DRIZZLE, useValue: db },
      { provide: PAYMENTS_PORT, useValue: { refundPaymentIntent } },
    ],
  }).compile();
  await ref.init();
  return {
    bus: ref.get(DomainEventBus),
    refunds: ref.get(RefundsService),
    cancel: ref.get(CancelService),
    refundPaymentIntent,
  };
}

const paymentsFor = (orderId: number) =>
  db
    .select()
    .from(orderPaymentsTable)
    .where(eq(orderPaymentsTable.orderId, orderId))
    .orderBy(orderPaymentsTable.id);

const eventTypes = async (orderId: number) =>
  (
    await db
      .select({ type: orderEventsTable.type })
      .from(orderEventsTable)
      .where(eq(orderEventsTable.orderId, orderId))
      .orderBy(orderEventsTable.id)
  ).map((e) => e.type);

const statusOf = async (orderId: number) =>
  (
    await db
      .select({ status: ordersTable.status })
      .from(ordersTable)
      .where(eq(ordersTable.id, orderId))
  )[0].status;

const netCollected = async (orderId: number) =>
  (await paymentsFor(orderId)).reduce((n, p) => n + p.amountCents, 0);

const stockAt = async (variantId: number) =>
  (
    await db
      .select({ stock: inventoryTable.stock })
      .from(inventoryTable)
      .where(eq(inventoryTable.variantId, variantId))
  )[0].stock;

describe('order lifecycle — charge webhook events reach the DB through the real bus', () => {
  it('CHARGE_REFUNDED → the sales handler reconciles a dashboard refund', async () => {
    const s = await seedPaidWebOrder(db);
    const { bus } = await build();

    await bus.emitAsync(DOMAIN_EVENTS.CHARGE_REFUNDED, {
      paymentIntentId: 'pi_test_1',
      refunds: [
        { stripeRefundId: 're_dash', amountCents: 4000, reason: 'fraudulent' },
      ],
    });

    const payments = await paymentsFor(s.orderId);
    expect(payments).toHaveLength(2);
    expect(payments[1]).toMatchObject({
      amountCents: -4000,
      stripeRefundId: 're_dash',
    });
    expect(await statusOf(s.orderId)).toBe('partially_refunded');
  });

  it('CHARGE_REFUNDED redelivery is a no-op through the full chain', async () => {
    const s = await seedPaidWebOrder(db);
    const { bus } = await build();
    const evt = {
      paymentIntentId: 'pi_test_1',
      refunds: [{ stripeRefundId: 're_once', amountCents: 4000, reason: null }],
    };

    await bus.emitAsync(DOMAIN_EVENTS.CHARGE_REFUNDED, evt);
    await bus.emitAsync(DOMAIN_EVENTS.CHARGE_REFUNDED, evt);

    expect(await paymentsFor(s.orderId)).toHaveLength(2);
  });

  it('CHARGE_DISPUTE_UPDATED → a note lands on the order', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const s = await seedPaidWebOrder(db);
    const { bus } = await build();

    await bus.emitAsync(DOMAIN_EVENTS.CHARGE_DISPUTE_UPDATED, {
      eventType: 'charge.dispute.created',
      disputeId: 'dp_1',
      chargeId: 'ch_1',
      paymentIntentId: 'pi_test_1',
      status: 'warning_needs_response',
      reason: 'fraudulent',
      amountCents: s.totalCents,
      evidenceDueBy: 1_700_000_000,
    });

    expect(await eventTypes(s.orderId)).toContain('note');
    jest.restoreAllMocks();
  });
});

describe('order lifecycle — composed operations on one order', () => {
  it('partial line refund then cancel: fully unwound, stock restored once', async () => {
    const s = await seedPaidWebOrder(db); // 2 x $50
    const { refunds, cancel, refundPaymentIntent } = await build(
      jest
        .fn()
        .mockResolvedValueOnce({ stripeRefundId: 're_line' })
        .mockResolvedValueOnce({ stripeRefundId: 're_cancel' }),
    );

    await refunds.refundOrder(
      s.orderId,
      s.accountId,
      { lines: [{ orderItemId: s.itemId, quantity: 1 }] },
      s.staffId,
    );
    expect(await statusOf(s.orderId)).toBe('partially_refunded');
    expect(await stockAt(s.variantId)).toBe(s.startStock - 1);

    const result = await cancel.cancelOrder(
      s.orderId,
      s.accountId,
      {},
      s.staffId,
    );

    expect(result.refundAmountCents).toBe(5000); // only the outstanding balance
    expect(await statusOf(s.orderId)).toBe('canceled');
    expect(await netCollected(s.orderId)).toBe(0); // money invariant
    expect(await stockAt(s.variantId)).toBe(s.startStock); // not over-restocked
    expect(refundPaymentIntent).toHaveBeenCalledTimes(2);

    expect(await eventTypes(s.orderId)).toEqual([
      'status_changed', // paid -> partially_refunded
      'refund',
      'status_changed', // partially_refunded -> refunded (cancel's balance refund)
      'refund',
      'status_changed', // refunded -> canceled
      'cancellation',
    ]);
  });

  it('full refund then a redelivered charge.refunded for the same refund is a no-op', async () => {
    const s = await seedPaidWebOrder(db);
    const { refunds, bus } = await build(
      jest.fn().mockResolvedValue({ stripeRefundId: 're_full' }),
    );

    await refunds.refundOrder(s.orderId, s.accountId, {}, s.staffId);
    expect(await statusOf(s.orderId)).toBe('refunded');

    await bus.emitAsync(DOMAIN_EVENTS.CHARGE_REFUNDED, {
      paymentIntentId: 'pi_test_1',
      refunds: [
        { stripeRefundId: 're_full', amountCents: s.totalCents, reason: null },
      ],
    });

    expect(await paymentsFor(s.orderId)).toHaveLength(2);
    expect(await statusOf(s.orderId)).toBe('refunded');
  });
});

describe('order lifecycle — status transition matrix against the DB', () => {
  it('applies every allowed transition and rejects the rest', async () => {
    const { accountId } = await seedPaidWebOrder(db);
    const staff = await insertUser(db, { accountId });

    for (const from of ORDER_STATUSES) {
      const allowed = new Set<string>(ALLOWED_TRANSITIONS[from]);
      for (const to of ORDER_STATUSES) {
        const order = await insertOrder(db, { accountId, status: from });
        const move = db.transaction((tx) =>
          transitionOrderStatus(tx, {
            orderId: order.id,
            to,
            actorType: 'staff',
            actorUserId: staff.id,
          }),
        );

        if (allowed.has(to)) {
          await move;
          expect(await statusOf(order.id)).toBe(to);
        } else {
          await expect(move).rejects.toBeInstanceOf(ConflictException);
          expect(await statusOf(order.id)).toBe(from);
        }
      }
    }
  });
});
