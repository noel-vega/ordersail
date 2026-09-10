import { Test } from '@nestjs/testing';
import { Logger } from 'logging';
import { eq, orderEventsTable } from 'db/sales';
import {
  insertAccount,
  insertOrder,
  insertOrderPayment,
  useTestDb,
} from 'test-support';
import { DRIZZLE } from 'src/shared/database/database.constants';
import type { ChargeDisputeUpdatedPayload } from 'src/shared/events';
import { DisputesService } from './disputes.service';

const db = useTestDb();

async function build() {
  const ref = await Test.createTestingModule({
    providers: [DisputesService, { provide: DRIZZLE, useValue: db }],
  }).compile();
  return ref.get(DisputesService);
}

async function seedOrderWithPayment() {
  const account = await insertAccount(db);
  const order = await insertOrder(db, {
    accountId: account.id,
    status: 'paid',
  });
  await insertOrderPayment(db, {
    orderId: order.id,
    method: 'stripe',
    amountCents: 2599,
    stripePaymentIntentId: 'pi_disp_1',
  });
  return { orderId: order.id };
}

const event = (
  over: Partial<ChargeDisputeUpdatedPayload> = {},
): ChargeDisputeUpdatedPayload => ({
  eventType: 'charge.dispute.created',
  disputeId: 'dp_1',
  chargeId: 'ch_1',
  paymentIntentId: 'pi_disp_1',
  status: 'warning_needs_response',
  reason: 'fraudulent',
  amountCents: 2599,
  evidenceDueBy: 1_700_000_000,
  ...over,
});

const eventsFor = (orderId: number) =>
  db
    .select()
    .from(orderEventsTable)
    .where(eq(orderEventsTable.orderId, orderId));

describe('DisputesService.recordDisputeEvent', () => {
  it('notes a created dispute on the order and raises an alert', async () => {
    const s = await seedOrderWithPayment();
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const service = await build();

    await service.recordDisputeEvent(event());

    const events = await eventsFor(s.orderId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'note',
      actorType: 'system',
      data: {
        kind: 'dispute',
        disputeId: 'dp_1',
        status: 'warning_needs_response',
      },
    });
    expect(events[0].message).toContain('Payment disputed');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[alert] Payment disputed'),
    );
    warn.mockRestore();
  });

  it('does not double-note a redelivered event', async () => {
    const s = await seedOrderWithPayment();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = await build();

    await service.recordDisputeEvent(event());
    await service.recordDisputeEvent(event());

    expect(await eventsFor(s.orderId)).toHaveLength(1);
  });

  it('alerts even when no order matches, without writing a note', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const service = await build();

    await service.recordDisputeEvent(event({ paymentIntentId: 'pi_nope' }));

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no matching order'),
    );
    warn.mockRestore();
  });

  it('words a lost closed dispute', async () => {
    const s = await seedOrderWithPayment();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = await build();

    await service.recordDisputeEvent(
      event({ eventType: 'charge.dispute.closed', status: 'lost' }),
    );

    const [note] = await eventsFor(s.orderId);
    expect(note.message).toBe('Dispute lost — $25.99 withdrawn.');
  });
});
