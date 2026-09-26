import { getQueueToken } from '@nestjs/bullmq';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { QUEUE_NAMES } from 'queue';
import {
  insertAccount,
  insertCart,
  insertLocation,
  insertOrder,
  insertOrderPayment,
  insertProductWithVariants,
  useTestDb,
} from 'test-support';
import { DRIZZLE } from 'src/shared/database/database.constants';
import {
  DOMAIN_EVENTS,
  DomainEventBus,
  type CheckoutSessionPaidPayload,
} from 'src/shared/events';
import { CartsService } from '../carts/carts.service';
import { CheckoutOrderService } from './checkout-order.service';
import { CheckoutOrderHandler } from './checkout-order.handler';

const db = useTestDb();

function event(
  over: Partial<CheckoutSessionPaidPayload> = {},
): CheckoutSessionPaidPayload {
  return {
    accountId: 0,
    cartToken: 'cart-tok',
    checkoutSessionId: 'cs_test_1',
    paymentIntentId: 'pi_test_1',
    customerEmail: 'buyer@test.com',
    customerName: 'Test Buyer',
    amountTotalCents: 26845,
    shippingAmountCents: 845,
    shippingLocationId: null,
    shippingAddress: null,
    ...over,
  };
}

describe('CheckoutOrderHandler (unit)', () => {
  function build(
    checkoutOrders: Partial<
      Record<'resolveOrderPayload' | 'enqueue', jest.Mock>
    >,
  ) {
    return new CheckoutOrderHandler(
      checkoutOrders as unknown as CheckoutOrderService,
    );
  }

  it('resolves the payload and enqueues it', async () => {
    const resolveOrderPayload = jest.fn().mockResolvedValue({ job: 'data' });
    const enqueue = jest.fn().mockResolvedValue(undefined);

    await build({ resolveOrderPayload, enqueue }).handle(event());

    expect(resolveOrderPayload).toHaveBeenCalledWith(event());
    expect(enqueue).toHaveBeenCalledWith({ job: 'data' });
  });

  it('does nothing when there is no payload to enqueue', async () => {
    const enqueue = jest.fn();

    await build({
      resolveOrderPayload: jest.fn().mockResolvedValue(null),
      enqueue,
    }).handle(event());

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('propagates an enqueue failure (the webhook must 5xx and Stripe retry)', async () => {
    const handler = build({
      resolveOrderPayload: jest.fn().mockResolvedValue({ job: 'data' }),
      enqueue: jest.fn().mockRejectedValue(new Error('redis down')),
    });

    await expect(handler.handle(event())).rejects.toThrow('redis down');
  });
});

describe('checkout.session.paid → order job (integration)', () => {
  async function build() {
    const ordersQueue = { add: jest.fn().mockResolvedValue({ id: '1' }) };
    const ref = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        CheckoutOrderHandler,
        CheckoutOrderService,
        CartsService,
        DomainEventBus,
        { provide: DRIZZLE, useValue: db },
        { provide: getQueueToken(QUEUE_NAMES.ORDERS), useValue: ordersQueue },
      ],
    }).compile();
    await ref.init();
    return { bus: ref.get(DomainEventBus), ordersQueue };
  }

  async function seedCart() {
    const account = await insertAccount(db);
    const location = await insertLocation(db, { accountId: account.id });
    const [variant] = await insertProductWithVariants(db, {
      accountId: account.id,
      productName: 'Sneakers',
      variants: [{ priceCents: 11500, sku: 'AF1-8', weightOz: 32 }],
    });
    await insertCart(db, {
      accountId: account.id,
      token: 'cart-tok',
      items: [{ variantId: variant.id, quantity: 2 }],
    });
    return {
      accountId: account.id,
      locationId: location.id,
      variantId: variant.id,
    };
  }

  it('emitAsync drives the handler → one checkout-completed job with the resolved payload', async () => {
    const s = await seedCart();
    const { bus, ordersQueue } = await build();

    await bus.emitAsync(
      DOMAIN_EVENTS.CHECKOUT_SESSION_PAID,
      event({ accountId: s.accountId }),
    );

    expect(ordersQueue.add).toHaveBeenCalledTimes(1);
    const [name, payload] = ordersQueue.add.mock.calls[0] as [
      string,
      {
        stripeCheckoutSessionId: string;
        subtotalCents: number;
        items: unknown[];
      },
    ];
    expect(name).toBe('checkout-completed');
    expect(payload).toMatchObject({
      stripeCheckoutSessionId: 'cs_test_1',
      accountId: s.accountId,
      subtotalCents: 23000,
    });
    expect(payload.items).toHaveLength(1);
  });

  it('emitAsync rejects when the order cannot be enqueued', async () => {
    const s = await seedCart();
    const { bus, ordersQueue } = await build();
    ordersQueue.add.mockRejectedValue(new Error('redis down'));

    await expect(
      bus.emitAsync(
        DOMAIN_EVENTS.CHECKOUT_SESSION_PAID,
        event({ accountId: s.accountId }),
      ),
    ).rejects.toThrow('redis down');
  });

  it('is idempotent — no job when an order already exists for the session', async () => {
    const s = await seedCart();
    const order = await insertOrder(db, { accountId: s.accountId });
    await insertOrderPayment(db, {
      orderId: order.id,
      stripeCheckoutSessionId: 'cs_test_1',
    });
    const { bus, ordersQueue } = await build();

    await bus.emitAsync(
      DOMAIN_EVENTS.CHECKOUT_SESSION_PAID,
      event({ accountId: s.accountId }),
    );

    expect(ordersQueue.add).not.toHaveBeenCalled();
  });
});
