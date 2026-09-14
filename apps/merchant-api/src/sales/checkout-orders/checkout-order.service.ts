import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Logger, getCorrelationId } from 'logging';
import { QUEUE_NAMES, type OrderJobData } from 'queue';
import { DRIZZLE } from 'src/shared/database/database.constants';
import type { CheckoutSessionPaidPayload } from 'src/shared/events';
import { type db as Db, eq, orderPaymentsTable } from 'db/sales';
import { CartsService } from '../carts/carts.service';

type CartItemOptionValue = { optionName: string; value: string };

// Turns a paid Stripe Checkout Session (a `checkout.session.paid` domain
// event) plus the customer's cart into the flattened snapshot apps/worker
// needs to write the order, and hands it off on the orders queue. The cart —
// not Stripe's line items — is the source of truth for what was ordered.
//
// Relocated from storefront-api's CheckoutService.handleWebhookEvent (M9):
// resolution + enqueue are sales-domain logic; the worker still does the write.
@Injectable()
export class CheckoutOrderService {
  private readonly logger = new Logger(CheckoutOrderService.name);

  constructor(
    private readonly carts: CartsService,
    @Inject(DRIZZLE) private readonly db: typeof Db,
    @InjectQueue(QUEUE_NAMES.ORDERS)
    private readonly ordersQueue: Queue<OrderJobData>,
  ) {}

  // null = nothing to order (cart already consumed by a prior delivery, or
  // empty) — the caller treats it as a no-op.
  async resolveOrderPayload(
    event: CheckoutSessionPaidPayload,
  ): Promise<OrderJobData | null> {
    const cart = await this.carts.findByToken(event.cartToken, event.accountId);
    if (!cart || cart.items.length === 0) {
      this.logger.warn(
        `checkout.session.paid ${event.checkoutSessionId}: cart ${event.cartToken} is gone or empty — no order created`,
      );
      return null;
    }

    const addr = event.shippingAddress;
    return {
      type: 'checkout-completed',
      correlationId: getCorrelationId() ?? randomUUID(),
      accountId: event.accountId,
      cartToken: event.cartToken,
      stripeCheckoutSessionId: event.checkoutSessionId,
      stripePaymentIntentId: event.paymentIntentId,
      customerEmail: event.customerEmail ?? '',
      customerName: event.customerName ?? addr?.name ?? '',
      shippingLine1: addr?.line1 ?? '',
      shippingLine2: addr?.line2 ?? null,
      shippingCity: addr?.city ?? '',
      shippingState: addr?.state ?? null,
      shippingPostalCode: addr?.postalCode ?? '',
      shippingCountry: addr?.country ?? '',
      subtotalCents: cart.subtotalCents,
      amountTotalCents: event.amountTotalCents ?? cart.subtotalCents,
      shippingCents: event.shippingAmountCents ?? 0,
      shippingLocationId: event.shippingLocationId,
      items: cart.items.map((item) => ({
        variantId: item.variantId,
        productName: item.productName,
        sku: item.sku,
        optionsLabel: optionsLabel(item.optionValues) || null,
        priceCents: item.priceCents,
        quantity: item.quantity,
      })),
    };
  }

  // Hands the resolved payload to apps/worker. Idempotency pre-check: the
  // checkout session id is unique on order_payments, so if a row already
  // exists the order was created by an earlier delivery — skip. The worker
  // re-checks the same key, so this only saves a pointless job; it is not the
  // safety net. A failure to add is deliberately NOT caught — losing a paid
  // order silently is worse than a re-delivered webhook (Stripe retries on a
  // non-2xx); the caller decides what a throw means.
  async enqueue(payload: OrderJobData): Promise<void> {
    const [existing] = await this.db
      .select({ id: orderPaymentsTable.id })
      .from(orderPaymentsTable)
      .where(
        eq(
          orderPaymentsTable.stripeCheckoutSessionId,
          payload.stripeCheckoutSessionId,
        ),
      );
    if (existing) {
      this.logger.log(
        `checkout ${payload.stripeCheckoutSessionId}: order already exists — skipping enqueue`,
      );
      return;
    }

    await this.ordersQueue.add('checkout-completed', payload);
    this.logger.log(
      `checkout ${payload.stripeCheckoutSessionId}: order job enqueued`,
    );
  }
}

function optionsLabel(optionValues: CartItemOptionValue[]): string {
  return optionValues.map((ov) => `${ov.optionName}: ${ov.value}`).join(', ');
}
