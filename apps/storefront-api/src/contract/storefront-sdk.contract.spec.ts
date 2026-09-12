// Replaces storefront-web's implicit role as storefront-api's only
// consumer-contract check (OS-425). storefront-web building/typechecking
// against generated types only ever caught a *type-level* break; this spins
// up the real app over real HTTP and drives it through the actual published
// SDK client, catching runtime contract breaks (status codes, response
// shapes, auth behavior) too. Required before M2 can remove storefront-web
// from this monorepo/CI without losing coverage.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { db as sharedDb } from 'db';
import type { Redis } from 'ioredis';
import type * as QueueModule from 'queue';
import {
  insertAccount,
  insertApiKey,
  insertLocation,
  insertProductWithVariants,
  insertStripeAccount,
  useTestDb,
} from 'test-support';
import { ApiError, StorefrontClient } from '@ordersail/storefront-sdk';
import { SHIPPO, STRIPE } from '../modules/checkout/checkout.constants';

// Two independent real ioredis connections get created as a side effect of
// importing AppModule: BullModule.forRoot's shared connection (app.module.ts)
// and HealthService's own dedicated one (deliberately separate, per its own
// comment). Both are created eagerly — a class-field initializer and a
// decorator argument both run before any Nest testing override can apply —
// and retried forever (maxRetriesPerRequest: null) if unreachable, e.g. in
// CI where no Redis service container exists. Nothing in this app ever
// closes either, since both are provided pre-built rather than something
// Nest constructed itself. Wrapping (not replacing) createRedisConnection
// here just stashes every real instance so afterAll can disconnect them —
// real connection behavior is unchanged. jest.mock calls are hoisted above
// the AppModule import below regardless of source order.
const capturedRedisConnections: Redis[] = [];
jest.mock('queue', () => {
  const actual = jest.requireActual<typeof QueueModule>('queue');
  return {
    ...actual,
    createRedisConnection: (
      ...args: Parameters<typeof actual.createRedisConnection>
    ) => {
      const connection = actual.createRedisConnection(...args);
      capturedRedisConnections.push(connection);
      return connection;
    },
  };
});

import { AppModule } from '../app.module';

const db = useTestDb();

function newStripeMock() {
  return {
    checkout: {
      sessions: { create: jest.fn(), retrieve: jest.fn(), update: jest.fn() },
    },
  };
}

describe('storefront-sdk contract', () => {
  let app: INestApplication<Server>;
  let baseUrl: string;
  let stripe: ReturnType<typeof newStripeMock>;

  beforeAll(async () => {
    stripe = newStripeMock();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(STRIPE)
      .useValue(stripe)
      .overrideProvider(SHIPPO)
      .useValue({ shipments: { create: jest.fn() } })
      .compile();

    // mirrors main.ts's bootstrap exactly (minus CORS, which only a browser
    // enforces, and Swagger, which nothing here reads)
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    app.use(cookieParser());
    await app.init();
    await app.listen(0);
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
    // DatabaseModule wires the `db` package's module-level singleton pool
    // (aliased sharedDb here — distinct from `db` above, useTestDb()'s own
    // connection) as the DRIZZLE provider. Nothing else in this app ever
    // closes it, since only this spec boots the full AppModule. Left open,
    // global-teardown.ts stopping the Testcontainers Postgres sends it an
    // unhandled termination error that crashes the whole Jest worker even
    // though every test already passed.
    await sharedDb.$client.end();
    capturedRedisConnections.forEach((connection) => connection.disconnect());
  });

  it('exercises every StorefrontClient resource against a real storefront-api', async () => {
    const account = await insertAccount(db);
    const apiKey = await insertApiKey(db, { accountId: account.id });
    await insertStripeAccount(db, { accountId: account.id });
    const location = await insertLocation(db, { accountId: account.id });
    const [variant] = await insertProductWithVariants(db, {
      accountId: account.id,
      variants: [
        { priceCents: 5000, stock: [{ locationId: location.id, stock: 10 }] },
      ],
    });

    const client = new StorefrontClient(baseUrl, apiKey.key);

    // products — reads, plain data
    const products = await client.products.list();
    expect(products?.items.map((p) => p.id)).toContain(variant.productId);

    const product = await client.products.getById(variant.productId);
    expect(product?.id).toBe(variant.productId);

    // cart — mutations throw, addItem captures the token onto the client
    const cart = await client.cart.addItem({
      variantId: variant.id,
      quantity: 2,
    });
    expect(cart.itemCount).toBe(2);
    expect(client.cartToken).toBe(cart.token);

    const fetchedCart = await client.cart.get();
    expect(fetchedCart?.itemCount).toBe(2);

    const updatedCart = await client.cart.updateItem(variant.id, {
      quantity: 3,
    });
    expect(updatedCart.items[0]?.quantity).toBe(3);

    // checkout — getConfig reflects the connected Stripe account we seeded
    const config = await client.checkout.getConfig();
    expect(config?.ready).toBe(true);

    stripe.checkout.sessions.create.mockResolvedValue({
      client_secret: 'cs_test_contract_secret',
    });
    const session = await client.checkout.createSession({
      returnUrl: 'http://localhost:3002/checkout/return',
    });
    expect(session.clientSecret).toBe('cs_test_contract_secret');

    await client.cart.clear();
    const clearedCart = await client.cart.get();
    expect(clearedCart?.itemCount ?? 0).toBe(0);

    // auth + customer — a real signup, then Bearer-authenticated calls
    const email = `contract-${account.id}@buyer.test`;
    await client.signUp({
      firstName: 'Contract',
      lastName: 'Tester',
      email,
      password: 'a-real-password-123',
    });

    const customer = await client.customer.get();
    expect(customer?.email).toBe(email);

    const updatedCustomer = await client.customer.update({
      firstName: 'Updated',
      lastName: 'Tester',
      email,
    });
    expect(updatedCustomer.firstName).toBe('Updated');
  });

  it('throws a typed ApiError with the real status on an invalid app key', async () => {
    const client = new StorefrontClient(baseUrl, 'sfk_not_a_real_key');

    await expect(
      client.cart.addItem({ variantId: 1, quantity: 1 }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      client.cart.addItem({ variantId: 1, quantity: 1 }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
