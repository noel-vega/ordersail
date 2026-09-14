import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { QUEUE_NAMES, type OrderJobData } from 'queue';
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
import type { CheckoutSessionPaidPayload } from 'src/shared/events';
import { CartsService } from '../carts/carts.service';
import { CheckoutOrderService } from './checkout-order.service';

const db = useTestDb();

async function build() {
  const ordersQueue = { add: jest.fn() };
  const ref = await Test.createTestingModule({
    providers: [
      CheckoutOrderService,
      CartsService,
      { provide: DRIZZLE, useValue: db },
      { provide: getQueueToken(QUEUE_NAMES.ORDERS), useValue: ordersQueue },
    ],
  }).compile();
  return {
    service: ref.get(CheckoutOrderService),
    carts: ref.get(CartsService),
    ordersQueue,
  };
}

// account + one location + a two-variant product (AF1 with a Size option,
// a bare tee) + a cart holding 2 × AF1 and 1 × tee. subtotal = 26000.
async function seed(token = 'cart-tok') {
  const account = await insertAccount(db);
  const location = await insertLocation(db, { accountId: account.id });
  const [af1, tee] = await insertProductWithVariants(db, {
    accountId: account.id,
    productName: 'Sneakers',
    variants: [
      {
        priceCents: 11500,
        sku: 'AF1-8',
        weightOz: 32,
        option: { name: 'Size', value: '8' },
        stock: [{ locationId: location.id, stock: 10 }],
      },
      { priceCents: 3000, sku: null, weightOz: null },
    ],
  });
  await insertCart(db, {
    accountId: account.id,
    token,
    items: [
      { variantId: af1.id, quantity: 2 },
      { variantId: tee.id, quantity: 1 },
    ],
  });
  return {
    accountId: account.id,
    locationId: location.id,
    af1: af1.id,
    tee: tee.id,
  };
}

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
    shippingAddress: {
      name: 'Test Buyer',
      line1: '1 Market St',
      line2: null,
      city: 'San Francisco',
      state: 'CA',
      postalCode: '94105',
      country: 'US',
    },
    ...over,
  };
}

const bySku = <T extends { sku: string | null }>(items: T[]) =>
  [...items].sort((a, b) => (a.sku ?? '').localeCompare(b.sku ?? ''));

describe('CartsService.findByToken', () => {
  it('returns the cart detail for a matching token + account', async () => {
    const s = await seed();
    const { carts } = await build();

    const cart = await carts.findByToken('cart-tok', s.accountId);

    expect(cart).toMatchObject({
      token: 'cart-tok',
      subtotalCents: 26000,
      itemCount: 3,
    });
    expect(bySku(cart!.items)).toMatchObject([
      { sku: null, priceCents: 3000, quantity: 1, optionValues: [] },
      {
        sku: 'AF1-8',
        priceCents: 11500,
        quantity: 2,
        optionValues: [{ optionName: 'Size', value: '8' }],
      },
    ]);
  });

  it('is undefined for an unknown token or a different account', async () => {
    const s = await seed();
    const { carts } = await build();

    expect(await carts.findByToken('nope', s.accountId)).toBeUndefined();
    expect(
      await carts.findByToken('cart-tok', s.accountId + 999),
    ).toBeUndefined();
  });
});

describe('CheckoutOrderService.resolveOrderPayload', () => {
  it('resolves the paid session + cart into a checkout-completed payload', async () => {
    const s = await seed();
    const { service } = await build();

    const payload = await service.resolveOrderPayload(
      event({ accountId: s.accountId, shippingLocationId: s.locationId }),
    );

    expect(payload).toMatchObject({
      type: 'checkout-completed',
      accountId: s.accountId,
      cartToken: 'cart-tok',
      stripeCheckoutSessionId: 'cs_test_1',
      stripePaymentIntentId: 'pi_test_1',
      customerEmail: 'buyer@test.com',
      customerName: 'Test Buyer',
      shippingLine1: '1 Market St',
      shippingLine2: null,
      shippingCity: 'San Francisco',
      shippingState: 'CA',
      shippingPostalCode: '94105',
      shippingCountry: 'US',
      subtotalCents: 26000,
      amountTotalCents: 26845,
      shippingCents: 845,
      shippingLocationId: s.locationId,
    });
    expect(payload!.correlationId).toEqual(expect.any(String));
    expect(bySku(payload!.items)).toEqual([
      {
        variantId: s.tee,
        productName: 'Sneakers',
        sku: null,
        optionsLabel: null,
        priceCents: 3000,
        quantity: 1,
      },
      {
        variantId: s.af1,
        productName: 'Sneakers',
        sku: 'AF1-8',
        optionsLabel: 'Size: 8',
        priceCents: 11500,
        quantity: 2,
      },
    ]);
  });

  it('falls back to the cart subtotal and empty address fields when the session omits them', async () => {
    const s = await seed();
    const { service } = await build();

    const payload = await service.resolveOrderPayload(
      event({
        accountId: s.accountId,
        amountTotalCents: null,
        shippingAmountCents: null,
        customerName: null,
        customerEmail: null,
        shippingAddress: null,
      }),
    );

    expect(payload).toMatchObject({
      customerEmail: '',
      customerName: '',
      shippingLine1: '',
      shippingLine2: null,
      shippingCity: '',
      shippingState: null,
      shippingPostalCode: '',
      shippingCountry: '',
      subtotalCents: 26000,
      amountTotalCents: 26000, // cart subtotal
      shippingCents: 0,
      shippingLocationId: null,
    });
  });

  it('returns null when the cart is gone or empty', async () => {
    const s = await seed();
    const emptyAccount = await insertAccount(db);
    await insertCart(db, { accountId: emptyAccount.id, token: 'empty-cart' });
    const { service } = await build();

    expect(
      await service.resolveOrderPayload(
        event({ accountId: s.accountId, cartToken: 'missing' }),
      ),
    ).toBeNull();
    expect(
      await service.resolveOrderPayload(
        event({ accountId: emptyAccount.id, cartToken: 'empty-cart' }),
      ),
    ).toBeNull();
  });
});

function payload(over: Partial<OrderJobData> = {}): OrderJobData {
  return {
    type: 'checkout-completed',
    correlationId: 'corr-1',
    accountId: 1,
    cartToken: 'cart-tok',
    stripeCheckoutSessionId: 'cs_test_1',
    stripePaymentIntentId: 'pi_test_1',
    customerEmail: 'buyer@test.com',
    customerName: 'Test Buyer',
    shippingLine1: '1 Market St',
    shippingLine2: null,
    shippingCity: 'San Francisco',
    shippingState: 'CA',
    shippingPostalCode: '94105',
    shippingCountry: 'US',
    subtotalCents: 26000,
    amountTotalCents: 26845,
    shippingCents: 845,
    shippingLocationId: null,
    items: [
      {
        variantId: 10,
        productName: 'Sneakers',
        sku: 'AF1-8',
        optionsLabel: 'Size: 8',
        priceCents: 11500,
        quantity: 2,
      },
    ],
    ...over,
  };
}

describe('CheckoutOrderService.enqueue', () => {
  it('adds one checkout-completed job with the payload and no options arg', async () => {
    const { service, ordersQueue } = await build();

    await service.enqueue(payload());

    expect(ordersQueue.add).toHaveBeenCalledTimes(1);
    expect(ordersQueue.add.mock.calls[0]).toEqual([
      'checkout-completed',
      payload(),
    ]);
  });

  it('skips the enqueue when an order_payments row already exists for the session', async () => {
    const account = await insertAccount(db);
    const order = await insertOrder(db, { accountId: account.id });
    await insertOrderPayment(db, {
      orderId: order.id,
      stripeCheckoutSessionId: 'cs_test_1',
    });
    const { service, ordersQueue } = await build();

    await service.enqueue(payload({ accountId: account.id }));

    expect(ordersQueue.add).not.toHaveBeenCalled();
  });

  it('lets an enqueue failure propagate (a lost paid order must not be swallowed)', async () => {
    const { service, ordersQueue } = await build();
    ordersQueue.add.mockRejectedValue(new Error('redis down'));

    await expect(service.enqueue(payload())).rejects.toThrow('redis down');
  });
});
