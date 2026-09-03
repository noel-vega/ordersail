import { BadRequestException, Logger } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { QUEUE_NAMES } from 'queue';
import { makeDb, firstCall } from 'test-support';
import { DRIZZLE } from '../../database/database.constants';
import { CartService } from '../cart/cart.service';
import { CheckoutService } from './checkout.service';
import { SHIPPO, STRIPE } from './checkout.constants';
import type Stripe from 'stripe';

interface StripeMock {
  checkout: {
    sessions: { create: jest.Mock; retrieve: jest.Mock; update: jest.Mock };
  };
  webhooks: { constructEvent: jest.Mock };
}

interface ShippoMock {
  shipments: { create: jest.Mock };
}

interface CartItem {
  variantId: number;
  quantity: number;
  productId: number;
  productName: string;
  sku: string | null;
  priceCents: number;
  stock: number;
  optionValues: { optionName: string; value: string }[];
}

const ACCOUNT_ID = 1;
const CONNECTED = 'acct_test_1';
const STRIPE_ACCOUNT_ROW = {
  accountId: ACCOUNT_ID,
  stripeAccountId: CONNECTED,
  chargesEnabled: true,
  detailsSubmitted: true,
};

function cartItem(over: Partial<CartItem> = {}): CartItem {
  return {
    variantId: 10,
    quantity: 1,
    productId: 5,
    productName: 'Nike Air Force 1',
    sku: 'AF1-8',
    priceCents: 11500,
    stock: 12,
    optionValues: [{ optionName: 'Size', value: '8' }],
    ...over,
  };
}

function cart(items: CartItem[] = [cartItem()], token = 'cart-tok-abc') {
  return {
    token,
    items,
    subtotalCents: items.reduce((s, i) => s + i.priceCents * i.quantity, 0),
    itemCount: items.reduce((s, i) => s + i.quantity, 0),
  };
}

function newStripeMock(): StripeMock {
  return {
    checkout: {
      sessions: { create: jest.fn(), retrieve: jest.fn(), update: jest.fn() },
    },
    webhooks: { constructEvent: jest.fn() },
  };
}

async function build(opts: {
  db: unknown;
  getCart?: jest.Mock;
  stripe?: StripeMock;
  shippo?: ShippoMock;
}) {
  const stripe = opts.stripe ?? newStripeMock();
  const shippo = opts.shippo ?? { shipments: { create: jest.fn() } };
  const cartService = { getCart: opts.getCart ?? jest.fn() };
  const ordersQueue = { add: jest.fn() };

  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [
      CheckoutService,
      { provide: DRIZZLE, useValue: opts.db },
      { provide: STRIPE, useValue: stripe },
      { provide: SHIPPO, useValue: shippo },
      { provide: CartService, useValue: cartService },
      {
        provide: getQueueToken(QUEUE_NAMES.ORDERS),
        useValue: ordersQueue,
      },
    ],
  }).compile();

  return {
    service: moduleRef.get(CheckoutService),
    stripe,
    shippo,
    cartService,
    ordersQueue,
  };
}

describe('CheckoutService.createSession', () => {
  const dto = { returnUrl: 'http://localhost:3002/checkout/return' };

  it('builds line items from the cart, not from the client, on the connected account', async () => {
    const items = [
      cartItem({ priceCents: 11500, quantity: 2 }),
      cartItem({
        variantId: 11,
        productName: 'Air Jordan 1',
        priceCents: 18000,
        quantity: 1,
        optionValues: [{ optionName: 'Size', value: '10' }],
      }),
    ];
    const getCart = jest.fn().mockResolvedValue(cart(items));
    const { service, stripe } = await build({
      db: makeDb([[STRIPE_ACCOUNT_ROW]]),
      getCart,
    });
    stripe.checkout.sessions.create.mockResolvedValue({
      client_secret: 'cs_test_x_secret_y',
    });

    await service.createSession('cart-tok-abc', ACCOUNT_ID, dto);

    expect(getCart).toHaveBeenCalledWith('cart-tok-abc', ACCOUNT_ID);
    const [params, options] = firstCall(stripe.checkout.sessions.create) as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(params.line_items).toEqual([
      {
        price_data: {
          currency: 'usd',
          unit_amount: 11500,
          product_data: { name: 'Nike Air Force 1 (Size: 8)' },
        },
        quantity: 2,
      },
      {
        price_data: {
          currency: 'usd',
          unit_amount: 18000,
          product_data: { name: 'Air Jordan 1 (Size: 10)' },
        },
        quantity: 1,
      },
    ]);
    expect(options).toEqual({ stripeAccount: CONNECTED });
  });

  it('sets the embedded-checkout session shape, return_url and metadata', async () => {
    const { service, stripe } = await build({
      db: makeDb([[STRIPE_ACCOUNT_ROW]]),
      getCart: jest.fn().mockResolvedValue(cart()),
    });
    stripe.checkout.sessions.create.mockResolvedValue({
      client_secret: 'cs_x',
    });

    await service.createSession('cart-tok-abc', ACCOUNT_ID, dto);

    const [params] = firstCall(stripe.checkout.sessions.create) as [
      Record<string, unknown>,
    ];
    expect(params).toMatchObject({
      mode: 'payment',
      ui_mode: 'embedded_page',
      shipping_address_collection: { allowed_countries: ['US'] },
      permissions: { update_shipping_details: 'server_only' },
      return_url:
        'http://localhost:3002/checkout/return?session_id={CHECKOUT_SESSION_ID}',
      metadata: { accountId: '1', cartToken: 'cart-tok-abc' },
    });
    expect(params.shipping_options).toEqual([
      {
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: { amount: 0, currency: 'usd' },
          display_name: 'Calculating…',
        },
      },
    ]);
  });

  it('returns the client secret from the created session', async () => {
    const { service, stripe } = await build({
      db: makeDb([[STRIPE_ACCOUNT_ROW]]),
      getCart: jest.fn().mockResolvedValue(cart()),
    });
    stripe.checkout.sessions.create.mockResolvedValue({
      client_secret: 'cs_test_abc_secret_def',
    });

    await expect(
      service.createSession('cart-tok-abc', ACCOUNT_ID, dto),
    ).resolves.toEqual({ clientSecret: 'cs_test_abc_secret_def' });
  });

  it('rejects when the store has no connected Stripe account', async () => {
    const { service, stripe } = await build({ db: makeDb([[]]) });

    await expect(
      service.createSession('cart-tok-abc', ACCOUNT_ID, dto),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('rejects when charges are not enabled on the connected account', async () => {
    const { service } = await build({
      db: makeDb([[{ ...STRIPE_ACCOUNT_ROW, chargesEnabled: false }]]),
    });

    await expect(
      service.createSession('cart-tok-abc', ACCOUNT_ID, dto),
    ).rejects.toThrow("This store isn't ready to accept payments yet");
  });

  it('rejects an empty or missing cart', async () => {
    for (const value of [undefined, cart([])]) {
      const { service } = await build({
        db: makeDb([[STRIPE_ACCOUNT_ROW]]),
        getCart: jest.fn().mockResolvedValue(value),
      });
      await expect(
        service.createSession('cart-tok-abc', ACCOUNT_ID, dto),
      ).rejects.toThrow('Cart is empty');
    }
  });

  it('rejects when a line exceeds available stock', async () => {
    const { service } = await build({
      db: makeDb([[STRIPE_ACCOUNT_ROW]]),
      getCart: jest
        .fn()
        .mockResolvedValue(cart([cartItem({ quantity: 5, stock: 2 })])),
    });

    await expect(
      service.createSession('cart-tok-abc', ACCOUNT_ID, dto),
    ).rejects.toThrow('Not enough stock for Nike Air Force 1');
  });

  it('rejects when Stripe returns a session without a client secret', async () => {
    const { service, stripe } = await build({
      db: makeDb([[STRIPE_ACCOUNT_ROW]]),
      getCart: jest.fn().mockResolvedValue(cart()),
    });
    stripe.checkout.sessions.create.mockResolvedValue({ client_secret: null });

    await expect(
      service.createSession('cart-tok-abc', ACCOUNT_ID, dto),
    ).rejects.toThrow('Failed to create checkout session');
  });
});

describe('CheckoutService.getShippingOptions', () => {
  const dto = {
    checkoutSessionId: 'cs_test_1',
    shippingDetails: {
      name: 'Test Buyer',
      address: {
        line1: '1600 Amphitheatre Parkway',
        city: 'Mountain View',
        state: 'CA',
        postal_code: '94043',
        country: 'US',
      },
    },
  };
  const location = {
    id: 7,
    name: 'Default',
    addressLine1: '2261 Market Street',
    addressLine2: null,
    addressCity: 'San Francisco',
    addressState: 'CA',
    addressPostalCode: '94114',
    addressCountry: 'US',
  };

  function stripeWithSession(): StripeMock {
    const s = newStripeMock();
    s.checkout.sessions.retrieve.mockResolvedValue({
      metadata: { cartToken: 'cart-tok-abc' },
    });
    s.checkout.sessions.update.mockResolvedValue({});
    return s;
  }

  it('quotes the 3 cheapest Shippo rates and records the ship-from location', async () => {
    const stripe = stripeWithSession();
    const shippo: ShippoMock = {
      shipments: {
        create: jest.fn().mockResolvedValue({
          objectId: 'shp_1',
          rates: [
            {
              amount: '12.10',
              provider: 'UPS',
              servicelevel: { name: 'Ground' },
            },
            {
              amount: '5.68',
              provider: 'USPS',
              servicelevel: { name: 'Ground Advantage' },
            },
            {
              amount: '20.00',
              provider: 'FedEx',
              servicelevel: { name: '2Day' },
            },
            {
              amount: '8.37',
              provider: 'USPS',
              servicelevel: { name: 'Priority' },
            },
          ],
        }),
      },
    };
    const { service } = await build({
      db: makeDb([
        [STRIPE_ACCOUNT_ROW],
        [location],
        [{ quantity: 1, weightOz: 32 }],
      ]),
      stripe,
      shippo,
    });

    await expect(service.getShippingOptions(ACCOUNT_ID, dto)).resolves.toEqual({
      ok: true,
    });

    const [sessionId, update, options] = firstCall(
      stripe.checkout.sessions.update,
    ) as [string, Record<string, unknown>, Record<string, unknown>];
    expect(sessionId).toBe('cs_test_1');
    expect(options).toEqual({ stripeAccount: CONNECTED });
    expect(update.shipping_options).toEqual([
      rate(568, 'USPS Ground Advantage'),
      rate(837, 'USPS Priority'),
      rate(1210, 'UPS Ground'),
    ]);
    expect(update.metadata).toMatchObject({ shippingLocationId: '7' });
  });

  it('fails when no location has a shipping-origin address', async () => {
    const shippo: ShippoMock = { shipments: { create: jest.fn() } };
    const { service } = await build({
      db: makeDb([[STRIPE_ACCOUNT_ROW], []]),
      stripe: stripeWithSession(),
      shippo,
    });

    await expect(service.getShippingOptions(ACCOUNT_ID, dto)).resolves.toEqual({
      ok: false,
      errorMessage: "This store hasn't set up a shipping origin yet",
    });
    expect(shippo.shipments.create).not.toHaveBeenCalled();
  });

  it('fails and logs when Shippo returns no rates', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const shippo: ShippoMock = {
      shipments: {
        create: jest.fn().mockResolvedValue({
          objectId: 'shp_2',
          rates: [],
          messages: [{ text: 'invalid destination zip' }],
        }),
      },
    };
    const { service } = await build({
      db: makeDb([
        [STRIPE_ACCOUNT_ROW],
        [location],
        [{ quantity: 1, weightOz: 32 }],
      ]),
      stripe: stripeWithSession(),
      shippo,
    });

    await expect(service.getShippingOptions(ACCOUNT_ID, dto)).resolves.toEqual({
      ok: false,
      errorMessage: "We can't calculate shipping to that address",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('invalid destination zip'),
    );
    warn.mockRestore();
  });

  it('fails when the store has no connected Stripe account', async () => {
    const { service } = await build({ db: makeDb([[]]) });

    await expect(service.getShippingOptions(ACCOUNT_ID, dto)).resolves.toEqual({
      ok: false,
      errorMessage: "This store isn't ready to accept payments yet",
    });
  });
});

function rate(amount: number, displayName: string) {
  return {
    shipping_rate_data: {
      type: 'fixed_amount',
      fixed_amount: { amount, currency: 'usd' },
      display_name: displayName,
    },
  };
}

describe('CheckoutService.handleWebhookEvent', () => {
  const RAW = Buffer.from('{}');
  const SIG = 'sig_test';

  // a realistic paid checkout.session.completed session object
  const baseSession = {
    id: 'cs_test_1',
    payment_status: 'paid',
    metadata: {
      accountId: '1',
      cartToken: 'cart-tok-abc',
      shippingLocationId: '7',
    },
    payment_intent: 'pi_test_1',
    collected_information: {
      shipping_details: {
        name: 'Test Buyer',
        address: {
          line1: '1 Main St',
          line2: null,
          city: 'SF',
          state: 'CA',
          postal_code: '94114',
          country: 'US',
        },
      },
    },
    customer_details: { email: 'buyer@test.com', name: 'Test Buyer' },
    amount_total: 12345,
    shipping_cost: { amount_total: 845 },
  };

  function completedEvent(
    sessionOverrides: Record<string, unknown> = {},
  ): Stripe.Event {
    return {
      type: 'checkout.session.completed',
      data: { object: { ...baseSession, ...sessionOverrides } },
    } as unknown as Stripe.Event;
  }

  async function webhook(opts: {
    event?: Stripe.Event;
    constructThrows?: Error;
    db?: unknown;
    getCart?: jest.Mock;
    queueAdd?: jest.Mock;
  }) {
    const stripe = newStripeMock();
    if (opts.constructThrows) {
      const err = opts.constructThrows;
      stripe.webhooks.constructEvent.mockImplementation(() => {
        throw err;
      });
    } else {
      stripe.webhooks.constructEvent.mockReturnValue(
        opts.event ?? completedEvent(),
      );
    }

    const built = await build({
      db: opts.db ?? makeDb([[]]),
      getCart: opts.getCart ?? jest.fn().mockResolvedValue(cart()),
      stripe,
    });
    if (opts.queueAdd) built.ordersQueue.add = opts.queueAdd;
    return built;
  }

  it('rejects with a 400 when the signature does not verify', async () => {
    const { service, ordersQueue } = await webhook({
      constructThrows: new Error('no signatures found matching the payload'),
    });

    await expect(service.handleWebhookEvent(RAW, SIG)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.handleWebhookEvent(RAW, SIG)).rejects.toThrow(
      /Webhook signature verification failed/,
    );
    expect(ordersQueue.add).not.toHaveBeenCalled();
  });

  it('ignores events that are not checkout.session.completed', async () => {
    const db = makeDb([[]]);
    const { service, cartService, ordersQueue } = await webhook({
      event: {
        type: 'payment_intent.succeeded',
        data: { object: {} },
      } as unknown as Stripe.Event,
      db,
    });

    await expect(service.handleWebhookEvent(RAW, SIG)).resolves.toBeUndefined();
    expect(db.select).not.toHaveBeenCalled();
    expect(cartService.getCart).not.toHaveBeenCalled();
    expect(ordersQueue.add).not.toHaveBeenCalled();
  });

  it('ignores a completed session that was not paid', async () => {
    const { service, ordersQueue } = await webhook({
      event: completedEvent({ payment_status: 'unpaid' }),
    });

    await expect(service.handleWebhookEvent(RAW, SIG)).resolves.toBeUndefined();
    expect(ordersQueue.add).not.toHaveBeenCalled();
  });

  it('ignores a session missing accountId or cartToken metadata', async () => {
    for (const metadata of [
      { cartToken: 'cart-tok-abc' },
      { accountId: '1' },
    ]) {
      const { service, cartService, ordersQueue } = await webhook({
        event: completedEvent({ metadata }),
      });

      await expect(
        service.handleWebhookEvent(RAW, SIG),
      ).resolves.toBeUndefined();
      expect(cartService.getCart).not.toHaveBeenCalled();
      expect(ordersQueue.add).not.toHaveBeenCalled();
    }
  });

  it('is idempotent — does nothing when a payment row already exists for the session', async () => {
    const { service, cartService, ordersQueue } = await webhook({
      db: makeDb([[{ id: 1 }]]),
    });

    await expect(service.handleWebhookEvent(RAW, SIG)).resolves.toBeUndefined();
    expect(cartService.getCart).not.toHaveBeenCalled();
    expect(ordersQueue.add).not.toHaveBeenCalled();
  });

  it('does not enqueue when the cart is gone or empty', async () => {
    for (const value of [undefined, cart([])]) {
      const { service, ordersQueue } = await webhook({
        getCart: jest.fn().mockResolvedValue(value),
      });

      await expect(
        service.handleWebhookEvent(RAW, SIG),
      ).resolves.toBeUndefined();
      expect(ordersQueue.add).not.toHaveBeenCalled();
    }
  });

  it('enqueues a checkout-completed job with the resolved order payload', async () => {
    const { service, ordersQueue } = await webhook({
      getCart: jest.fn().mockResolvedValue(
        cart([
          cartItem(),
          cartItem({
            variantId: 11,
            productName: 'AJ1',
            sku: null,
            optionValues: [],
          }),
        ]),
      ),
    });

    await service.handleWebhookEvent(RAW, SIG);

    expect(ordersQueue.add).toHaveBeenCalledTimes(1);
    const [name, payload] = firstCall(ordersQueue.add) as [
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe('checkout-completed');
    expect(firstCall(ordersQueue.add)).toHaveLength(2); // no job-options arg
    expect(payload).toMatchObject({
      type: 'checkout-completed',
      accountId: 1,
      cartToken: 'cart-tok-abc',
      stripeCheckoutSessionId: 'cs_test_1',
      stripePaymentIntentId: 'pi_test_1',
      customerEmail: 'buyer@test.com',
      customerName: 'Test Buyer',
      shippingLine1: '1 Main St',
      shippingLine2: null,
      shippingCity: 'SF',
      shippingState: 'CA',
      shippingPostalCode: '94114',
      shippingCountry: 'US',
      subtotalCents: 23000,
      amountTotalCents: 12345,
      shippingCents: 845,
      shippingLocationId: 7,
      storefrontUrl: 'http://localhost:3002',
    });
    expect(payload.correlationId).toEqual(expect.any(String));
    expect(payload.items).toEqual([
      {
        variantId: 10,
        productName: 'Nike Air Force 1',
        sku: 'AF1-8',
        optionsLabel: 'Size: 8',
        priceCents: 11500,
        quantity: 1,
      },
      {
        variantId: 11,
        productName: 'AJ1',
        sku: null,
        optionsLabel: null,
        priceCents: 11500,
        quantity: 1,
      },
    ]);
  });

  it('records no payment intent id when Stripe expands payment_intent to an object', async () => {
    const { service, ordersQueue } = await webhook({
      event: completedEvent({ payment_intent: { id: 'pi_x' } }),
    });

    await service.handleWebhookEvent(RAW, SIG);

    const [, payload] = firstCall(ordersQueue.add) as [
      string,
      Record<string, unknown>,
    ];
    expect(payload.stripePaymentIntentId).toBeNull();
  });

  it('falls back to safe defaults for nullable session fields', async () => {
    const { service, ordersQueue } = await webhook({
      event: completedEvent({
        amount_total: null,
        shipping_cost: undefined,
        metadata: { accountId: '1', cartToken: 'cart-tok-abc' },
      }),
    });

    await service.handleWebhookEvent(RAW, SIG);

    const [, payload] = firstCall(ordersQueue.add) as [
      string,
      Record<string, unknown>,
    ];
    expect(payload).toMatchObject({
      amountTotalCents: 11500, // cart.subtotalCents
      shippingCents: 0,
      shippingLocationId: null,
    });
  });

  it('uses empty strings when the session has no collected shipping details', async () => {
    const { service, ordersQueue } = await webhook({
      event: completedEvent({
        collected_information: undefined,
        customer_details: { email: 'b@t.com', name: null },
      }),
    });

    await service.handleWebhookEvent(RAW, SIG);

    const [, payload] = firstCall(ordersQueue.add) as [
      string,
      Record<string, unknown>,
    ];
    expect(payload).toMatchObject({
      customerName: '',
      shippingLine1: '',
      shippingLine2: null,
      shippingCity: '',
      shippingState: null,
      shippingPostalCode: '',
      shippingCountry: '',
    });
  });

  it('lets an enqueue failure propagate (a lost paid order must not be swallowed)', async () => {
    const { service } = await webhook({
      queueAdd: jest.fn().mockRejectedValue(new Error('redis down')),
    });

    await expect(service.handleWebhookEvent(RAW, SIG)).rejects.toThrow(
      'redis down',
    );
  });
});
