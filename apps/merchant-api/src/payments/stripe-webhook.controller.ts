import {
  Controller,
  Inject,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { constructWebhookEvent } from 'payments';
import type Stripe from 'stripe';
import { Logger } from 'logging';
import { env } from 'src/shared/env';
import { Public } from 'src/shared/auth/decorators';
import {
  DOMAIN_EVENTS,
  DomainEventBus,
  type ChargeDisputeUpdatedPayload,
  type ChargeRefundedPayload,
  type CheckoutSessionPaidPayload,
} from 'src/shared/events';
import { STRIPE } from './payments.constants';
import { StripeConnectService } from './stripe-connect.service';

// The one Stripe webhook endpoint — a Stripe event destination is a single URL
// + a single signing secret, so every subscribed event lands here and is
// dispatched by type: Connect (`account.updated`), Checkout
// (`checkout.session.*`), and charge lifecycle (`charge.refunded`,
// `charge.dispute.*` — OS-127). Subscribed in the Stripe Dashboard to "events
// on connected accounts", as Snapshot (v1) events.
//
// The checkout webhook was moved off storefront-api in M9 (OS-357); the two
// merchant-api controllers were merged here in OS-360.
@Controller('webhooks')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(
    @Inject(STRIPE) private readonly stripe: Stripe,
    private readonly stripeConnect: StripeConnectService,
    private readonly events: DomainEventBus,
  ) {}

  @Public()
  @Post('stripe')
  @ApiExcludeEndpoint()
  async handle(@Req() req: RawBodyRequest<FastifyRequest>) {
    // verifies the signature or throws a 400 (see packages/payments)
    const event = constructWebhookEvent(
      this.stripe,
      req.rawBody,
      req.headers['stripe-signature'],
      env.STRIPE_WEBHOOK_SECRET,
    );

    switch (event.type) {
      case 'account.updated': {
        // the durable path for keeping charges_enabled / details_submitted in
        // sync — event.account is the connected account id on a Connect event
        if (event.account) {
          const account = event.data.object;
          await this.stripeConnect.handleAccountUpdated(event.account, {
            charges_enabled: account.charges_enabled,
            details_submitted: account.details_submitted,
          });
        }
        break;
      }

      // async_payment_succeeded = a delayed payment method settled after the
      // session first "completed" unpaid — same paid path as completed.
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const payload = toPaidPayload(event.data.object);
        if (payload) {
          // emitAsync, not emit: if the sales handler can't enqueue the order
          // (e.g. Redis is down) this rejects, the endpoint returns non-2xx,
          // and Stripe redelivers — a paid order must never be silently lost.
          await this.events.emitAsync(
            DOMAIN_EVENTS.CHECKOUT_SESSION_PAID,
            payload,
          );
        } else {
          this.logger.log(
            `${event.type} ${event.data.object.id}: not paid or missing accountId/cartToken metadata — ignored`,
          );
        }
        break;
      }

      // A delayed payment method (some bank debits) failed to settle after
      // the session first "completed" unpaid. No order was ever created, so
      // there's nothing to unwind — log it and move on. The specific failure
      // reason lives on the PaymentIntent, not the session; surfacing a
      // provisional order as `payment_failed` waits on the order-status model
      // (OS-118 / M2).
      case 'checkout.session.async_payment_failed': {
        const session = event.data.object;
        const paymentIntentId =
          typeof session.payment_intent === 'string'
            ? session.payment_intent
            : (session.payment_intent?.id ?? 'none');
        this.logger.warn(
          `${event.type} ${session.id}: async payment did not settle ` +
            `(payment_status=${session.payment_status}, payment_intent=${paymentIntentId}) — no order created`,
        );
        break;
      }

      // The customer opened checkout and never paid; the session TTL lapsed.
      // The cart is untouched, so they can start over — nothing to do beyond
      // recording that it happened.
      case 'checkout.session.expired': {
        this.logger.log(
          `${event.type} ${event.data.object.id}: session expired unpaid — cart left intact`,
        );
        break;
      }

      // A refund was created on a charge — usually one the merchant issued in
      // the Stripe Dashboard. sales reconciles: writes the negative
      // order_payments row(s) it's missing and moves the status. Refunds
      // OrderSail issued are already recorded (by stripeRefundId) and skipped.
      // emitAsync so a failed reconcile → non-2xx → Stripe redelivers.
      case 'charge.refunded': {
        const payload = toChargeRefundedPayload(event.data.object);
        if (payload) {
          await this.events.emitAsync(DOMAIN_EVENTS.CHARGE_REFUNDED, payload);
        } else {
          this.logger.warn(
            `${event.type} ${event.data.object.id}: no payment_intent — cannot map to an order`,
          );
        }
        break;
      }

      // A dispute (chargeback) opened / updated / closed. sales notes it on the
      // order and raises an alert; it does not auto-refund (OS-141 / M4 owns
      // the money side).
      case 'charge.dispute.created':
      case 'charge.dispute.closed':
      case 'charge.dispute.funds_withdrawn':
      case 'charge.dispute.funds_reinstated': {
        await this.events.emitAsync(
          DOMAIN_EVENTS.CHARGE_DISPUTE_UPDATED,
          toDisputePayload(event.type, event.data.object),
        );
        break;
      }
    }

    return { received: true };
  }
}

function toChargeRefundedPayload(
  charge: Stripe.Charge,
): ChargeRefundedPayload | null {
  const paymentIntentId =
    typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : (charge.payment_intent?.id ?? null);
  if (!paymentIntentId) return null;

  return {
    paymentIntentId,
    refunds: (charge.refunds?.data ?? []).map((r) => ({
      stripeRefundId: r.id,
      amountCents: r.amount,
      reason: r.reason ?? null,
    })),
  };
}

function toDisputePayload(
  eventType: string,
  dispute: Stripe.Dispute,
): ChargeDisputeUpdatedPayload {
  return {
    eventType,
    disputeId: dispute.id,
    chargeId:
      typeof dispute.charge === 'string' ? dispute.charge : dispute.charge.id,
    paymentIntentId:
      typeof dispute.payment_intent === 'string'
        ? dispute.payment_intent
        : (dispute.payment_intent?.id ?? null),
    status: dispute.status,
    reason: dispute.reason ?? null,
    amountCents: dispute.amount,
    evidenceDueBy: dispute.evidence_details?.due_by ?? null,
  };
}

// the paid session → the `checkout.session.paid` payload, or null when it
// isn't actually paid or is missing the metadata the storefront set at
// session-creation time
function toPaidPayload(
  session: Stripe.Checkout.Session,
): CheckoutSessionPaidPayload | null {
  if (session.payment_status !== 'paid') return null;

  const accountId = Number(session.metadata?.accountId);
  const cartToken = session.metadata?.cartToken;
  if (!accountId || !cartToken) return null;

  const shipping = session.collected_information?.shipping_details;
  return {
    accountId,
    cartToken,
    checkoutSessionId: session.id,
    paymentIntentId:
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : null,
    customerEmail: session.customer_details?.email ?? null,
    customerName: session.customer_details?.name ?? null,
    amountTotalCents: session.amount_total ?? null,
    shippingAmountCents: session.shipping_cost?.amount_total ?? null,
    shippingLocationId: Number(session.metadata?.shippingLocationId) || null,
    shippingAddress: shipping
      ? {
          name: shipping.name ?? null,
          line1: shipping.address?.line1 ?? null,
          line2: shipping.address?.line2 ?? null,
          city: shipping.address?.city ?? null,
          state: shipping.address?.state ?? null,
          postalCode: shipping.address?.postal_code ?? null,
          country: shipping.address?.country ?? null,
        }
      : null,
  };
}
