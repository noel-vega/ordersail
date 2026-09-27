import { BadRequestException } from '@nestjs/common';
import { Logger } from 'logging';
import { Test, TestingModule } from '@nestjs/testing';
import {
  firstCall,
  insertAccount,
  insertCart,
  insertLocation,
  insertProductWithVariants,
  insertStripeAccount,
  useTestDb,
} from 'test-support';
import { DRIZZLE } from '../../database/database.constants';
import { CartService } from '../cart/cart.service';
import { CheckoutService } from './checkout.service';
import { SHIPPO, STRIPE } from './checkout.constants';

const db = useTestDb();

interface StripeMock {
  checkout: {
    sessions: { create: jest.Mock; retrieve: jest.Mock; update: jest.Mock };
  };
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
  };
}

async function build(opts: {
  getCart?: jest.Mock;
  stripe?: StripeMock;
  shippo?: ShippoMock;
}) {
  const stripe = opts.stripe ?? newStripeMock();
  const shippo = opts.shippo ?? { shipments: { create: jest.fn() } };
  const cartService = { getCart: opts.getCart ?? jest.fn() };

  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [
      CheckoutService,
      { provide: DRIZZLE, useValue: db },
      { provide: STRIPE, useValue: stripe },
      { provide: SHIPPO, useValue: shippo },
      { provide: CartService, useValue: cartService },
    ],
  }).compile();

  return {
    service: moduleRef.get(CheckoutService),
    stripe,
    shippo,
    cartService,
  };
}

// account + connected Stripe account; returns the ids the tests assert against
async function seedConnected(opts: { chargesEnabled?: boolean } = {}) {
  const account = await insertAccount(db);
  const stripeAccount = await insertStripeAccount(db, {
    accountId: account.id,
    chargesEnabled: opts.chargesEnabled ?? true,
  });
  return { accountId: account.id, connected: stripeAccount.stripeAccountId };
}

describe('CheckoutService.createSession', () => {
  const dto = { returnUrl: 'http://localhost:3002/checkout/return' };

  it('builds line items from the cart, not from the client, on the connected account', async () => {
    const { accountId, connected } = await seedConnected();
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
    const { service, stripe } = await build({ getCart });
    stripe.checkout.sessions.create.mockResolvedValue({
      client_secret: 'cs_test_x_secret_y',
    });

    await service.createSession('cart-tok-abc', accountId, dto);

    expect(getCart).toHaveBeenCalledWith('cart-tok-abc', accountId);
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
    expect(options).toMatchObject({ stripeAccount: connected });
    expect(options.idempotencyKey).toEqual(expect.any(String));
  });

  it('reuses one idempotency key for the same cart and a different one when it changes', async () => {
    const { accountId } = await seedConnected();
    const { service, stripe } = await build({
      getCart: jest
        .fn()
        .mockResolvedValueOnce(cart([cartItem({ quantity: 1 })]))
        .mockResolvedValueOnce(cart([cartItem({ quantity: 1 })]))
        .mockResolvedValueOnce(cart([cartItem({ quantity: 2 })])),
    });
    stripe.checkout.sessions.create.mockResolvedValue({
      client_secret: 'cs_x',
    });

    await service.createSession('cart-tok-abc', accountId, dto);
    await service.createSession('cart-tok-abc', accountId, dto);
    await service.createSession('cart-tok-abc', accountId, dto);

    const keys = (
      stripe.checkout.sessions.create.mock.calls as unknown[][]
    ).map((c) => (c[1] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).toBe(keys[1]); // unchanged cart → same key → Stripe replays
    expect(keys[2]).not.toBe(keys[0]); // qty changed → new key → fresh session
  });

  it('sets the embedded-checkout session shape, return_url and metadata', async () => {
    const { accountId } = await seedConnected();
    const { service, stripe } = await build({
      getCart: jest.fn().mockResolvedValue(cart()),
    });
    stripe.checkout.sessions.create.mockResolvedValue({
      client_secret: 'cs_x',
    });

    await service.createSession('cart-tok-abc', accountId, dto);

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
      metadata: { accountId: String(accountId), cartToken: 'cart-tok-abc' },
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
    const { accountId } = await seedConnected();
    const { service, stripe } = await build({
      getCart: jest.fn().mockResolvedValue(cart()),
    });
    stripe.checkout.sessions.create.mockResolvedValue({
      client_secret: 'cs_test_abc_secret_def',
    });

    await expect(
      service.createSession('cart-tok-abc', accountId, dto),
    ).resolves.toEqual({ clientSecret: 'cs_test_abc_secret_def' });
  });

  it('rejects when the store has no connected Stripe account', async () => {
    const account = await insertAccount(db);
    const { service, stripe } = await build({});

    await expect(
      service.createSession('cart-tok-abc', account.id, dto),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('rejects when charges are not enabled on the connected account', async () => {
    const { accountId } = await seedConnected({ chargesEnabled: false });
    const { service } = await build({});

    await expect(
      service.createSession('cart-tok-abc', accountId, dto),
    ).rejects.toThrow("This store isn't ready to accept payments yet");
  });

  it('rejects an empty or missing cart', async () => {
    for (const value of [undefined, cart([])]) {
      const { accountId } = await seedConnected();
      const { service } = await build({
        getCart: jest.fn().mockResolvedValue(value),
      });
      await expect(
        service.createSession('cart-tok-abc', accountId, dto),
      ).rejects.toThrow('Cart is empty');
    }
  });

  it('rejects when a line exceeds available stock', async () => {
    const { accountId } = await seedConnected();
    const { service } = await build({
      getCart: jest
        .fn()
        .mockResolvedValue(cart([cartItem({ quantity: 5, stock: 2 })])),
    });

    await expect(
      service.createSession('cart-tok-abc', accountId, dto),
    ).rejects.toThrow('Not enough stock for Nike Air Force 1');
  });

  it('rejects when Stripe returns a session without a client secret', async () => {
    const { accountId } = await seedConnected();
    const { service, stripe } = await build({
      getCart: jest.fn().mockResolvedValue(cart()),
    });
    stripe.checkout.sessions.create.mockResolvedValue({ client_secret: null });

    await expect(
      service.createSession('cart-tok-abc', accountId, dto),
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

  function stripeWithSession(): StripeMock {
    const s = newStripeMock();
    s.checkout.sessions.retrieve.mockResolvedValue({
      metadata: { cartToken: 'cart-tok-abc' },
    });
    s.checkout.sessions.update.mockResolvedValue({});
    return s;
  }

  // a connected account + a ship-from location + a cart whose single line
  // weighs 32oz, so totalCartWeightOz has real rows to sum
  async function seedShippable() {
    const { accountId, connected } = await seedConnected();
    const location = await insertLocation(db, { accountId });
    const [variant] = await insertProductWithVariants(db, {
      accountId,
      variants: [{ priceCents: 11500, weightOz: 32 }],
    });
    await insertCart(db, {
      accountId,
      token: 'cart-tok-abc',
      items: [{ variantId: variant.id, quantity: 1 }],
    });
    return { accountId, connected, locationId: location.id };
  }

  it('quotes the 3 cheapest Shippo rates and records the ship-from location', async () => {
    const { accountId, connected, locationId } = await seedShippable();
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
    const { service } = await build({ stripe, shippo });

    await expect(service.getShippingOptions(accountId, dto)).resolves.toEqual({
      ok: true,
    });

    const [sessionId, update, options] = firstCall(
      stripe.checkout.sessions.update,
    ) as [string, Record<string, unknown>, Record<string, unknown>];
    expect(sessionId).toBe('cs_test_1');
    expect(options).toEqual({ stripeAccount: connected });
    expect(update.shipping_options).toEqual([
      rate(568, 'USPS Ground Advantage'),
      rate(837, 'USPS Priority'),
      rate(1210, 'UPS Ground'),
    ]);
    expect(update.metadata).toMatchObject({
      shippingLocationId: String(locationId),
    });
  });

  it('fails when no location has a shipping-origin address', async () => {
    const { accountId } = await seedConnected();
    await insertLocation(db, { accountId, withAddress: false });
    const shippo: ShippoMock = { shipments: { create: jest.fn() } };
    const { service } = await build({ stripe: stripeWithSession(), shippo });

    await expect(service.getShippingOptions(accountId, dto)).resolves.toEqual({
      ok: false,
      errorMessage: "This store hasn't set up a shipping origin yet",
    });
    expect(shippo.shipments.create).not.toHaveBeenCalled();
  });

  it('fails and logs when Shippo returns no rates', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { accountId } = await seedShippable();
    const shippo: ShippoMock = {
      shipments: {
        create: jest.fn().mockResolvedValue({
          objectId: 'shp_2',
          rates: [],
          messages: [{ text: 'invalid destination zip' }],
        }),
      },
    };
    const { service } = await build({ stripe: stripeWithSession(), shippo });

    await expect(service.getShippingOptions(accountId, dto)).resolves.toEqual({
      ok: false,
      errorMessage: "We can't calculate shipping to that address",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'shippo.no_rates_returned',
        shipmentId: 'shp_2',
        shippoMessages: 'invalid destination zip',
      }),
      expect.any(String),
    );
    warn.mockRestore();
  });

  it('fails when the store has no connected Stripe account', async () => {
    const account = await insertAccount(db);
    const { service } = await build({});

    await expect(service.getShippingOptions(account.id, dto)).resolves.toEqual({
      ok: false,
      errorMessage: "This store isn't ready to accept payments yet",
    });
  });
});

describe('CheckoutService.getSessionStatus', () => {
  function stripeReturning(
    session: Record<string, unknown> | null,
  ): StripeMock {
    const stripe = newStripeMock();
    stripe.checkout.sessions.retrieve.mockResolvedValue(session);
    return stripe;
  }

  it('passes through status, payment_status and the customer email', async () => {
    const { accountId, connected } = await seedConnected();
    const { service, stripe } = await build({
      stripe: stripeReturning({
        status: 'complete',
        payment_status: 'paid',
        customer_details: { email: 'buyer@test.com' },
      }),
    });

    await expect(
      service.getSessionStatus(accountId, 'cs_test_1'),
    ).resolves.toEqual({
      status: 'complete',
      paymentStatus: 'paid',
      customerEmail: 'buyer@test.com',
    });
    // scoped to this account's connected Stripe account
    expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledWith(
      'cs_test_1',
      undefined,
      { stripeAccount: connected },
    );
  });

  it('reports an unpaid complete session (async payment pending / failed)', async () => {
    const { accountId } = await seedConnected();
    const { service } = await build({
      stripe: stripeReturning({
        status: 'complete',
        payment_status: 'unpaid',
        customer_details: { email: null },
      }),
    });

    await expect(
      service.getSessionStatus(accountId, 'cs_test_2'),
    ).resolves.toEqual({
      status: 'complete',
      paymentStatus: 'unpaid',
      customerEmail: null,
    });
  });

  it('falls back to open/unpaid when Stripe omits the fields', async () => {
    const { accountId } = await seedConnected();
    const { service } = await build({ stripe: stripeReturning({}) });

    await expect(
      service.getSessionStatus(accountId, 'cs_test_3'),
    ).resolves.toEqual({
      status: 'open',
      paymentStatus: 'unpaid',
      customerEmail: null,
    });
  });

  it('404s when the account has no connected Stripe account', async () => {
    const account = await insertAccount(db);
    const { service } = await build({});

    await expect(
      service.getSessionStatus(account.id, 'cs_test_4'),
    ).rejects.toThrow();
  });

  it('404s when the session cannot be retrieved', async () => {
    const { accountId } = await seedConnected();
    const stripe = newStripeMock();
    stripe.checkout.sessions.retrieve.mockRejectedValue(
      new Error('no such session'),
    );
    const { service } = await build({ stripe });

    await expect(
      service.getSessionStatus(accountId, 'cs_missing'),
    ).rejects.toThrow();
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
