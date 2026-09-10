import { Inject, Injectable } from '@nestjs/common';
import { Logger } from 'logging';
import {
  and,
  type db as Db,
  eq,
  gt,
  orderEventsTable,
  orderPaymentsTable,
  sql,
} from 'db/sales';
import { DRIZZLE } from 'src/shared/database/database.constants';
import type { ChargeDisputeUpdatedPayload } from 'src/shared/events';

const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;

@Injectable()
export class DisputesService {
  private readonly logger = new Logger(DisputesService.name);

  constructor(@Inject(DRIZZLE) private readonly db: typeof Db) {}

  // OS-127: a `charge.dispute.*` webhook — note it on the order and raise an
  // alert. Does not touch the money (the merchant responds in Stripe; full
  // accounting is OS-141 / M4).
  async recordDisputeEvent(input: ChargeDisputeUpdatedPayload): Promise<void> {
    const message = disputeMessage(input);

    const tender = input.paymentIntentId
      ? (
          await this.db
            .select({ orderId: orderPaymentsTable.orderId })
            .from(orderPaymentsTable)
            .where(
              and(
                eq(
                  orderPaymentsTable.stripePaymentIntentId,
                  input.paymentIntentId,
                ),
                gt(orderPaymentsTable.amountCents, 0),
              ),
            )
        )[0]
      : undefined;

    // a redelivered dispute event shouldn't add a second identical note
    const alreadyNoted =
      tender &&
      (
        await this.db
          .select({ id: orderEventsTable.id })
          .from(orderEventsTable)
          .where(
            and(
              eq(orderEventsTable.orderId, tender.orderId),
              eq(orderEventsTable.type, 'note'),
              sql`${orderEventsTable.data} ->> 'disputeId' = ${input.disputeId}`,
              sql`${orderEventsTable.data} ->> 'eventType' = ${input.eventType}`,
            ),
          )
          .limit(1)
      ).length > 0;

    if (tender && !alreadyNoted) {
      await this.db.insert(orderEventsTable).values({
        orderId: tender.orderId,
        type: 'note',
        data: {
          kind: 'dispute',
          disputeId: input.disputeId,
          eventType: input.eventType,
          status: input.status,
          reason: input.reason,
          amountCents: input.amountCents,
          evidenceDueBy: input.evidenceDueBy,
        },
        message,
        actorType: 'system',
        actorUserId: null,
      });
    }

    this.logger.warn(
      `[alert] ${message} (dispute ${input.disputeId}, charge ${input.chargeId}` +
        (tender ? `, order ${tender.orderId})` : ', no matching order)'),
    );
  }
}

function disputeMessage(d: ChargeDisputeUpdatedPayload): string {
  const amt = fmt(d.amountCents);
  switch (d.eventType) {
    case 'charge.dispute.created': {
      const due = d.evidenceDueBy
        ? ` Respond by ${new Date(d.evidenceDueBy * 1000).toISOString().slice(0, 10)}.`
        : '';
      return `Payment disputed (${d.reason ?? 'unknown reason'}) — ${amt} at risk.${due}`;
    }
    case 'charge.dispute.closed':
      return d.status === 'won'
        ? `Dispute won — ${amt} retained.`
        : `Dispute lost — ${amt} withdrawn.`;
    case 'charge.dispute.funds_withdrawn':
      return `Disputed funds withdrawn — ${amt}.`;
    case 'charge.dispute.funds_reinstated':
      return `Disputed funds reinstated — ${amt}.`;
    default:
      return `Dispute ${d.status} — ${amt}.`;
  }
}
