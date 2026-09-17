import { Test, TestingModule } from '@nestjs/testing';
import {
  insertAccount,
  insertCustomer,
  insertFulfillment,
  insertLocation,
  insertOrder,
  insertOrderItem,
  insertOrderPayment,
  insertOrderRefundLine,
  insertOrderShipping,
  useTestDb,
} from 'test-support';
import { CustomerOrdersService } from './customer-orders.service';
import { DRIZZLE } from '../../../database/database.constants';

const db = useTestDb();

async function build() {
  const module: TestingModule = await Test.createTestingModule({
    providers: [CustomerOrdersService, { provide: DRIZZLE, useValue: db }],
  }).compile();
  return module.get<CustomerOrdersService>(CustomerOrdersService);
}

const page = { limit: 20, offset: 0 };

describe('CustomerOrdersService.findAll', () => {
  it('returns an empty page for a customer with no orders', async () => {
    const account = await insertAccount(db);
    const customer = await insertCustomer(db, { accountId: account.id });
    const service = await build();

    const result = await service.findAll(page, customer.id, account.id);

    expect(result).toEqual({ items: [], total: 0, limit: 20, offset: 0 });
  });

  it("lists only this customer's orders in this account, newest first", async () => {
    const account = await insertAccount(db);
    const other = await insertAccount(db);
    const customer = await insertCustomer(db, { accountId: account.id });
    const someoneElse = await insertCustomer(db, { accountId: account.id });

    const older = await insertOrder(db, {
      accountId: account.id,
      customerId: customer.id,
      amountTotalCents: 1000,
    });
    const newer = await insertOrder(db, {
      accountId: account.id,
      customerId: customer.id,
      amountTotalCents: 2000,
    });
    // guest checkout with the same email, another customer, and the same
    // customer id under a different tenant — none of these are theirs
    await insertOrder(db, { accountId: account.id, customerId: null });
    await insertOrder(db, {
      accountId: account.id,
      customerId: someoneElse.id,
    });
    await insertOrder(db, { accountId: other.id, customerId: customer.id });
    const service = await build();

    const result = await service.findAll(page, customer.id, account.id);

    expect(result.total).toBe(2);
    // same created_at within a test run is possible, so id breaks the tie
    expect(result.items.map((o) => o.id)).toEqual([newer.id, older.id]);
  });

  it('is empty when the customer id is presented under the wrong account', async () => {
    const account = await insertAccount(db);
    const other = await insertAccount(db);
    const customer = await insertCustomer(db, { accountId: account.id });
    await insertOrder(db, { accountId: account.id, customerId: customer.id });
    const service = await build();

    const result = await service.findAll(page, customer.id, other.id);

    expect(result).toEqual({ items: [], total: 0, limit: 20, offset: 0 });
  });

  it('derives itemCount and fulfillmentStatus per order', async () => {
    const account = await insertAccount(db);
    const customer = await insertCustomer(db, { accountId: account.id });
    const location = await insertLocation(db, { accountId: account.id });

    const unfulfilled = await insertOrder(db, {
      accountId: account.id,
      customerId: customer.id,
      status: 'paid',
      amountTotalCents: 3000,
    });
    await insertOrderItem(db, { orderId: unfulfilled.id, quantity: 3 });

    const partial = await insertOrder(db, {
      accountId: account.id,
      customerId: customer.id,
    });
    const partialItem = await insertOrderItem(db, {
      orderId: partial.id,
      quantity: 2,
    });
    await insertOrderItem(db, { orderId: partial.id, quantity: 1 });
    await insertFulfillment(db, {
      orderId: partial.id,
      locationId: location.id,
      items: [{ orderItemId: partialItem.id, quantity: 2 }],
    });

    const fulfilled = await insertOrder(db, {
      accountId: account.id,
      customerId: customer.id,
      status: 'partially_refunded',
    });
    const fulfilledItem = await insertOrderItem(db, {
      orderId: fulfilled.id,
      quantity: 1,
    });
    await insertFulfillment(db, {
      orderId: fulfilled.id,
      locationId: location.id,
      items: [{ orderItemId: fulfilledItem.id, quantity: 1 }],
    });
    const service = await build();

    const result = await service.findAll(page, customer.id, account.id);
    const byId = new Map(result.items.map((o) => [o.id, o]));

    expect(byId.get(unfulfilled.id)).toMatchObject({
      status: 'paid',
      itemCount: 3,
      fulfillmentStatus: 'unfulfilled',
      amountTotalCents: 3000,
    });
    expect(byId.get(partial.id)).toMatchObject({
      itemCount: 3,
      fulfillmentStatus: 'partially_fulfilled',
    });
    expect(byId.get(fulfilled.id)).toMatchObject({
      status: 'partially_refunded',
      itemCount: 1,
      fulfillmentStatus: 'fulfilled',
    });
  });

  it('paginates with limit/offset and reports the full total', async () => {
    const account = await insertAccount(db);
    const customer = await insertCustomer(db, { accountId: account.id });
    for (let i = 0; i < 3; i++) {
      await insertOrder(db, { accountId: account.id, customerId: customer.id });
    }
    const service = await build();

    const first = await service.findAll(
      { limit: 2, offset: 0 },
      customer.id,
      account.id,
    );
    const second = await service.findAll(
      { limit: 2, offset: 2 },
      customer.id,
      account.id,
    );

    expect(first.total).toBe(3);
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(second).toMatchObject({ total: 3, limit: 2, offset: 2 });
  });
});

describe('CustomerOrdersService.findOne', () => {
  it('returns undefined for an unknown id', async () => {
    const account = await insertAccount(db);
    const customer = await insertCustomer(db, { accountId: account.id });
    const service = await build();

    await expect(
      service.findOne(999999, customer.id, account.id),
    ).resolves.toBeUndefined();
  });

  it("returns undefined for another customer's order, a guest order, or the wrong account", async () => {
    const account = await insertAccount(db);
    const other = await insertAccount(db);
    const customer = await insertCustomer(db, { accountId: account.id });
    const someoneElse = await insertCustomer(db, { accountId: account.id });
    const theirs = await insertOrder(db, {
      accountId: account.id,
      customerId: someoneElse.id,
    });
    const guest = await insertOrder(db, {
      accountId: account.id,
      customerId: null,
      customerEmail: customer.email,
    });
    const mine = await insertOrder(db, {
      accountId: account.id,
      customerId: customer.id,
    });
    const service = await build();

    await expect(
      service.findOne(theirs.id, customer.id, account.id),
    ).resolves.toBeUndefined();
    await expect(
      service.findOne(guest.id, customer.id, account.id),
    ).resolves.toBeUndefined();
    await expect(
      service.findOne(mine.id, customer.id, other.id),
    ).resolves.toBeUndefined();
  });

  it('returns items, shipping, payments and fulfillments without staff-only fields', async () => {
    const account = await insertAccount(db);
    const customer = await insertCustomer(db, { accountId: account.id });
    const location = await insertLocation(db, { accountId: account.id });
    const order = await insertOrder(db, {
      accountId: account.id,
      customerId: customer.id,
      status: 'partially_refunded',
      customerName: 'Shopper Buyer',
      customerEmail: customer.email,
      subtotalCents: 7000,
      shippingCents: 500,
      amountTotalCents: 7500,
    });
    await insertOrderShipping(db, {
      orderId: order.id,
      locationId: location.id,
      line1: '1 Main St',
      line2: null,
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'US',
    });
    const shirt = await insertOrderItem(db, {
      orderId: order.id,
      productName: 'Shirt',
      sku: 'SHIRT-M',
      optionsLabel: 'M',
      priceCents: 2000,
      quantity: 2,
    });
    const hat = await insertOrderItem(db, {
      orderId: order.id,
      productName: 'Hat',
      priceCents: 3000,
      quantity: 1,
    });
    const charge = await insertOrderPayment(db, {
      orderId: order.id,
      method: 'stripe',
      amountCents: 7500,
      stripeCheckoutSessionId: 'cs_test_detail',
      stripePaymentIntentId: 'pi_test_detail',
    });
    const refund = await insertOrderPayment(db, {
      orderId: order.id,
      method: 'stripe',
      amountCents: -3000,
      stripeRefundId: 're_test_detail',
      reason: 'internal note: customer was rude',
      parentPaymentId: charge.id,
    });
    await insertOrderRefundLine(db, {
      refundPaymentId: refund.id,
      orderItemId: hat.id,
      quantity: 1,
    });
    await insertFulfillment(db, {
      orderId: order.id,
      locationId: location.id,
      items: [{ orderItemId: shirt.id, quantity: 2 }],
      shippingCarrier: 'UPS',
      shippingServiceLevel: 'Ground',
      trackingNumber: '1Z999',
      trackingUrl: 'https://track.test/1Z999',
      labelUrl: 'https://labels.test/secret.pdf',
      amountCents: 1234,
    });
    const service = await build();

    const detail = await service.findOne(order.id, customer.id, account.id);

    expect(detail).toMatchObject({
      id: order.id,
      status: 'partially_refunded',
      // 2 of 3 units shipped
      fulfillmentStatus: 'partially_fulfilled',
      customerName: 'Shopper Buyer',
      customerEmail: customer.email,
      subtotalCents: 7000,
      shippingCents: 500,
      taxCents: 0,
      amountTotalCents: 7500,
    });
    expect(detail?.shipping).toEqual({
      line1: '1 Main St',
      line2: null,
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'US',
    });
    expect(detail?.items).toEqual([
      {
        id: shirt.id,
        variantId: null,
        productName: 'Shirt',
        sku: 'SHIRT-M',
        optionsLabel: 'M',
        priceCents: 2000,
        quantity: 2,
        fulfilledQuantity: 2,
        refundedQuantity: 0,
      },
      {
        id: hat.id,
        variantId: null,
        productName: 'Hat',
        sku: null,
        optionsLabel: null,
        priceCents: 3000,
        quantity: 1,
        fulfilledQuantity: 0,
        refundedQuantity: 1,
      },
    ]);
    expect(
      detail?.payments.map(({ method, amountCents }) => ({
        method,
        amountCents,
      })),
    ).toEqual([
      { method: 'stripe', amountCents: 7500 },
      { method: 'stripe', amountCents: -3000 },
    ]);
    expect(detail?.fulfillments).toHaveLength(1);
    const [fulfillment] = detail!.fulfillments;
    expect(fulfillment.createdAt).toBeInstanceOf(Date);
    expect(fulfillment).toMatchObject({
      shippingCarrier: 'UPS',
      shippingServiceLevel: 'Ground',
      trackingNumber: '1Z999',
      trackingUrl: 'https://track.test/1Z999',
      items: [{ orderItemId: shirt.id, quantity: 2 }],
    });
    expect(Object.keys(fulfillment).sort()).toEqual(
      [
        'createdAt',
        'id',
        'items',
        'shippingCarrier',
        'shippingServiceLevel',
        'trackingNumber',
        'trackingUrl',
      ].sort(),
    );

    // nothing the merchant keeps for themselves leaks into the payload
    const serialized = JSON.stringify(detail);
    for (const leaked of [
      'internal note',
      're_test_detail',
      'cs_test_detail',
      'pi_test_detail',
      'labels.test',
      'locationId',
      'events',
      'allocations',
    ]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it('returns null shipping and empty collections for a bare order', async () => {
    const account = await insertAccount(db);
    const customer = await insertCustomer(db, { accountId: account.id });
    const order = await insertOrder(db, {
      accountId: account.id,
      customerId: customer.id,
    });
    const service = await build();

    const detail = await service.findOne(order.id, customer.id, account.id);

    expect(detail).toMatchObject({
      shipping: null,
      items: [],
      payments: [],
      fulfillments: [],
      fulfillmentStatus: 'unfulfilled',
    });
  });
});
