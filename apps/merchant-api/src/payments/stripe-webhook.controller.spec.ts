import { BadRequestException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Test } from '@nestjs/testing';
import type Stripe from 'stripe';
import { Logger } from 'logging';
import { DOMAIN_EVENTS, DomainEventBus } from 'src/shared/events';
import { STRIPE } from './payments.constants';
import { StripeConnectService } from './stripe-connect.service';
import { StripeWebhookController } from './stripe-webhook.controller';

// the injected Stripe client's only job in this controller is signature
// verification (via `constructWebhookEvent`), so a stub of `webhooks.constructEvent`
// is the whole surface — returning an event, or throwing on a bad signature.
const constructEvent = jest.fn();

const baseSession = {
  id: 'cs_test_1',
  payment_status: 'paid',
  payment_intent: 'pi_test_1',
  metadata: { accountId: '7', cartToken: 'cart-tok', shippingLocationId: '3' },
  customer_details: { email: 'buyer@test.com', name: 'Test Buyer' },
  amount_total: 26845,
  shipping_cost: { amount_total: 845 },
  collected_information: {
    shipping_details: {
      name: 'Test Buyer',
      address: {
        line1: '1 Market St',
        line2: null,
        city: 'San Francisco',
        state: 'CA',
        postal_code: '94105',
        country: 'US',
      },
    },
  },
};

function checkoutEvent(
  type: string,
  sessionOverrides: Record<string, unknown> = {},
): Stripe.Event {
  return {
    type,
    data: { object: { ...baseSession, ...sessionOverrides } },
  } as unknown as Stripe.Event;
}

function accountUpdatedEvent(
  overrides: {
    account?: string | null;
    charges_enabled?: boolean;
    details_submitted?: boolean;
  } = {},
): Stripe.Event {
  return {
    type: 'account.updated',
    account: overrides.account === undefined ? 'acct_123' : overrides.account,
    data: {
      object: {
        charges_enabled: overrides.charges_enabled ?? true,
        details_submitted: overrides.details_submitted ?? true,
      },
    },
  } as unknown as Stripe.Event;
}

const REQ = {
  rawBody: Buffer.from('{}'),
  headers: { 'stripe-signature': 'sig_test' },
} as unknown as RawBodyRequest<FastifyRequest>;

async function build() {
  const emitAsync = jest.fn().mockResolvedValue(undefined);
  const handleAccountUpdated = jest.fn().mockResolvedValue(undefined);
  const ref = await Test.createTestingModule({
    controllers: [StripeWebhookController],
    providers: [
      { provide: STRIPE, useValue: { webhooks: { constructEvent } } },
      { provide: DomainEventBus, useValue: { emitAsync } },
      { provide: StripeConnectService, useValue: { handleAccountUpdated } },
    ],
  }).compile();
  return {
    controller: ref.get(StripeWebhookController),
    emitAsync,
    handleAccountUpdated,
  };
}

beforeEach(() => constructEvent.mockReset());

describe('StripeWebhookController', () => {
  it('rejects with a 400 when the signature does not verify', async () => {
    constructEvent.mockImplementation(() => {
      throw new Error('bad sig');
    });
    const { controller, emitAsync, handleAccountUpdated } = await build();

    await expect(controller.handle(REQ)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(emitAsync).not.toHaveBeenCalled();
    expect(handleAccountUpdated).not.toHaveBeenCalled();
  });

  describe('account.updated', () => {
    it('syncs the connected account status', async () => {
      constructEvent.mockReturnValue(
        accountUpdatedEvent({
          charges_enabled: true,
          details_submitted: false,
        }),
      );
      const { controller, handleAccountUpdated } = await build();

      await expect(controller.handle(REQ)).resolves.toEqual({ received: true });
      expect(handleAccountUpdated).toHaveBeenCalledWith('acct_123', {
        charges_enabled: true,
        details_submitted: false,
      });
    });

    it('ignores the event when it carries no connected account id', async () => {
      constructEvent.mockReturnValue(accountUpdatedEvent({ account: null }));
      const { controller, handleAccountUpdated } = await build();

      await controller.handle(REQ);

      expect(handleAccountUpdated).not.toHaveBeenCalled();
    });
  });

  describe('checkout.session.*', () => {
    it('emits checkout.session.paid for a paid completed session', async () => {
      constructEvent.mockReturnValue(
        checkoutEvent('checkout.session.completed'),
      );
      const { controller, emitAsync } = await build();

      await expect(controller.handle(REQ)).resolves.toEqual({ received: true });
      expect(emitAsync).toHaveBeenCalledTimes(1);
      expect(emitAsync).toHaveBeenCalledWith(
        DOMAIN_EVENTS.CHECKOUT_SESSION_PAID,
        {
          accountId: 7,
          cartToken: 'cart-tok',
          checkoutSessionId: 'cs_test_1',
          paymentIntentId: 'pi_test_1',
          customerEmail: 'buyer@test.com',
          customerName: 'Test Buyer',
          amountTotalCents: 26845,
          shippingAmountCents: 845,
          shippingLocationId: 3,
          shippingAddress: {
            name: 'Test Buyer',
            line1: '1 Market St',
            line2: null,
            city: 'San Francisco',
            state: 'CA',
            postalCode: '94105',
            country: 'US',
          },
        },
      );
    });

    it('also emits for async_payment_succeeded', async () => {
      constructEvent.mockReturnValue(
        checkoutEvent('checkout.session.async_payment_succeeded'),
      );
      const { controller, emitAsync } = await build();

      await controller.handle(REQ);

      expect(emitAsync).toHaveBeenCalledWith(
        DOMAIN_EVENTS.CHECKOUT_SESSION_PAID,
        expect.objectContaining({ checkoutSessionId: 'cs_test_1' }),
      );
    });

    it('propagates a handler failure so Stripe redelivers', async () => {
      constructEvent.mockReturnValue(
        checkoutEvent('checkout.session.completed'),
      );
      const { controller, emitAsync } = await build();
      emitAsync.mockRejectedValue(new Error('redis down'));

      await expect(controller.handle(REQ)).rejects.toThrow('redis down');
    });

    it('does not emit when the session is not paid', async () => {
      constructEvent.mockReturnValue(
        checkoutEvent('checkout.session.completed', {
          payment_status: 'unpaid',
        }),
      );
      const { controller, emitAsync } = await build();

      await controller.handle(REQ);

      expect(emitAsync).not.toHaveBeenCalled();
    });

    it('does not emit when accountId or cartToken metadata is missing', async () => {
      const { controller, emitAsync } = await build();
      for (const metadata of [{ cartToken: 'x' }, { accountId: '1' }, {}]) {
        constructEvent.mockReturnValue(
          checkoutEvent('checkout.session.completed', { metadata }),
        );
        await controller.handle(REQ);
      }
      expect(emitAsync).not.toHaveBeenCalled();
    });

    it('records no payment intent id when Stripe expands payment_intent to an object', async () => {
      constructEvent.mockReturnValue(
        checkoutEvent('checkout.session.completed', {
          payment_intent: { id: 'pi_x' },
        }),
      );
      const { controller, emitAsync } = await build();

      await controller.handle(REQ);

      expect(emitAsync).toHaveBeenCalledWith(
        DOMAIN_EVENTS.CHECKOUT_SESSION_PAID,
        expect.objectContaining({ paymentIntentId: null }),
      );
    });

    it('falls back to nulls when the session omits amounts and shipping', async () => {
      constructEvent.mockReturnValue(
        checkoutEvent('checkout.session.completed', {
          amount_total: null,
          shipping_cost: undefined,
          collected_information: undefined,
          customer_details: { email: null, name: null },
          metadata: { accountId: '7', cartToken: 'cart-tok' },
        }),
      );
      const { controller, emitAsync } = await build();

      await controller.handle(REQ);

      expect(emitAsync).toHaveBeenCalledWith(
        DOMAIN_EVENTS.CHECKOUT_SESSION_PAID,
        {
          accountId: 7,
          cartToken: 'cart-tok',
          checkoutSessionId: 'cs_test_1',
          paymentIntentId: 'pi_test_1',
          customerEmail: null,
          customerName: null,
          amountTotalCents: null,
          shippingAmountCents: null,
          shippingLocationId: null,
          shippingAddress: null,
        },
      );
    });

    it('logs async_payment_failed at warn and creates no order', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      constructEvent.mockReturnValue(
        checkoutEvent('checkout.session.async_payment_failed', {
          payment_status: 'unpaid',
          payment_intent: 'pi_test_1',
        }),
      );
      const { controller, emitAsync } = await build();

      await expect(controller.handle(REQ)).resolves.toEqual({ received: true });
      expect(emitAsync).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cs_test_1'));
      warn.mockRestore();
    });

    it('acknowledges an expired session without creating an order', async () => {
      constructEvent.mockReturnValue(
        checkoutEvent('checkout.session.expired', {
          status: 'expired',
          payment_status: 'unpaid',
        }),
      );
      const { controller, emitAsync } = await build();

      await expect(controller.handle(REQ)).resolves.toEqual({ received: true });
      expect(emitAsync).not.toHaveBeenCalled();
    });
  });

  it('ignores unrelated event types', async () => {
    constructEvent.mockReturnValue(checkoutEvent('payment_intent.succeeded'));
    const { controller, emitAsync, handleAccountUpdated } = await build();

    await expect(controller.handle(REQ)).resolves.toEqual({ received: true });
    expect(emitAsync).not.toHaveBeenCalled();
    expect(handleAccountUpdated).not.toHaveBeenCalled();
  });

  describe('charge.refunded', () => {
    const chargeEvent = (object: Record<string, unknown>): Stripe.Event =>
      ({
        type: 'charge.refunded',
        data: { object },
      }) as unknown as Stripe.Event;

    it('emits charge.refunded with the payment intent + refund list', async () => {
      constructEvent.mockReturnValue(
        chargeEvent({
          id: 'ch_1',
          payment_intent: 'pi_1',
          refunds: {
            data: [
              { id: 're_1', amount: 2000, reason: 'requested_by_customer' },
              { id: 're_2', amount: 500, reason: null },
            ],
          },
        }),
      );
      const { controller, emitAsync } = await build();

      await expect(controller.handle(REQ)).resolves.toEqual({ received: true });
      expect(emitAsync).toHaveBeenCalledWith(DOMAIN_EVENTS.CHARGE_REFUNDED, {
        paymentIntentId: 'pi_1',
        refunds: [
          {
            stripeRefundId: 're_1',
            amountCents: 2000,
            reason: 'requested_by_customer',
          },
          { stripeRefundId: 're_2', amountCents: 500, reason: null },
        ],
      });
    });

    it('warns and does not emit when the charge has no payment intent', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      constructEvent.mockReturnValue(
        chargeEvent({ id: 'ch_2', refunds: { data: [] } }),
      );
      const { controller, emitAsync } = await build();

      await controller.handle(REQ);

      expect(emitAsync).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ch_2'));
      warn.mockRestore();
    });
  });

  describe('charge.dispute.*', () => {
    const disputeEvent = (
      type: string,
      object: Record<string, unknown> = {},
    ): Stripe.Event =>
      ({
        type,
        data: {
          object: {
            id: 'dp_1',
            charge: 'ch_1',
            payment_intent: 'pi_1',
            status: 'warning_needs_response',
            reason: 'fraudulent',
            amount: 2599,
            evidence_details: { due_by: 1_700_000_000 },
            ...object,
          },
        },
      }) as unknown as Stripe.Event;

    it('emits charge.dispute.updated for a created dispute', async () => {
      constructEvent.mockReturnValue(disputeEvent('charge.dispute.created'));
      const { controller, emitAsync } = await build();

      await expect(controller.handle(REQ)).resolves.toEqual({ received: true });
      expect(emitAsync).toHaveBeenCalledWith(
        DOMAIN_EVENTS.CHARGE_DISPUTE_UPDATED,
        {
          eventType: 'charge.dispute.created',
          disputeId: 'dp_1',
          chargeId: 'ch_1',
          paymentIntentId: 'pi_1',
          status: 'warning_needs_response',
          reason: 'fraudulent',
          amountCents: 2599,
          evidenceDueBy: 1_700_000_000,
        },
      );
    });

    it('also emits for a closed dispute', async () => {
      constructEvent.mockReturnValue(
        disputeEvent('charge.dispute.closed', { status: 'lost' }),
      );
      const { controller, emitAsync } = await build();

      await controller.handle(REQ);

      expect(emitAsync).toHaveBeenCalledWith(
        DOMAIN_EVENTS.CHARGE_DISPUTE_UPDATED,
        expect.objectContaining({
          eventType: 'charge.dispute.closed',
          status: 'lost',
        }),
      );
    });
  });
});
