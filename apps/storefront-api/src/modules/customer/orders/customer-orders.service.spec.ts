import { Test, TestingModule } from '@nestjs/testing';
import {
  insertAccount,
  insertCustomer,
  insertFulfillment,
  insertLocation,
  insertOrder,
  insertOrderItem,
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
