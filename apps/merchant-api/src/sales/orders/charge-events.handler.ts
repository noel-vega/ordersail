import { Injectable } from '@nestjs/common';
import {
  DOMAIN_EVENTS,
  OnDomainEvent,
  type ChargeDisputeUpdatedPayload,
  type ChargeRefundedPayload,
} from 'src/shared/events';
import { RefundsService } from './refunds.service';
import { DisputesService } from './disputes.service';

// Reacts to the charge-lifecycle events the payments context emits from the
// Stripe webhook (OS-127). Both are awaited via DomainEventBus.emitAsync, so a
// thrown error → the webhook returns non-2xx → Stripe redelivers. Both
// downstream calls are idempotent (refund matched on stripeRefundId; a dispute
// note is cheap to re-write, and disputes are low-volume).
@Injectable()
export class ChargeEventsHandler {
  constructor(
    private readonly refunds: RefundsService,
    private readonly disputes: DisputesService,
  ) {}

  @OnDomainEvent(DOMAIN_EVENTS.CHARGE_REFUNDED)
  handleRefunded(event: ChargeRefundedPayload): Promise<void> {
    return this.refunds.reconcileExternalRefund(event);
  }

  @OnDomainEvent(DOMAIN_EVENTS.CHARGE_DISPUTE_UPDATED)
  handleDispute(event: ChargeDisputeUpdatedPayload): Promise<void> {
    return this.disputes.recordDisputeEvent(event);
  }
}
