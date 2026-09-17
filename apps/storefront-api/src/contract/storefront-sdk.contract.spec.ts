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
  insertOrder,
  insertOrderItem,
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
    // ~15 sequential real HTTP+DB round-trips through a fully booted app —
    // the point of a consumer-contract test. Jest's 30s default is too
    // tight for that in CI (this is the only DB-touching spec in this
    // project, so Testcontainers Postgres cold-start isn't amortized).
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

    // customer order history — orders are written by the worker, so seed one
    // linked to the customer we just signed up
    const emptyHistory = await client.customer.orders.list();
    expect(emptyHistory.total).toBe(0);

    const order = await insertOrder(db, {
      accountId: account.id,
      customerId: updatedCustomer.id,
      customerEmail: email,
    });
    await insertOrderItem(db, { orderId: order.id, quantity: 2 });

    const history = await client.customer.orders.list({ limit: 10 });
    expect(history.items.map((o) => o.id)).toEqual([order.id]);
    expect(history.items[0]?.itemCount).toBe(2);

    const detail = await client.customer.orders.getById(order.id);
    expect(detail?.id).toBe(order.id);
    expect(detail?.items[0]?.quantity).toBe(2);

    await expect(
      client.customer.orders.getById(order.id + 1000),
    ).resolves.toBeUndefined();
  }, 90000);

  // OS-459: refreshAccessToken() must capture the server's rotated
  // refresh_token, not just access_token — otherwise every session breaks
  // after its first refresh once the server rotates (OS-457)
  it('rotates refresh tokens on refreshAccessToken() and fires onTokensChanged', async () => {
    const account = await insertAccount(db);
    const apiKey = await insertApiKey(db, { accountId: account.id });
    const tokenChanges: Array<{
      accessToken: string | undefined;
      refreshToken: string | undefined;
    }> = [];
    const client = new StorefrontClient(
      baseUrl,
      apiKey.key,
      undefined,
      undefined,
      { onTokensChanged: (tokens) => tokenChanges.push(tokens) },
    );

    await client.signUp({
      firstName: 'Rotation',
      lastName: 'Tester',
      email: `rotation-${account.id}@buyer.test`,
      password: 'a-real-password-123',
    });
    expect(tokenChanges).toHaveLength(1);
    const firstRefreshToken = client.refreshToken;

    const newAccessToken = await client.refreshAccessToken();

    expect(newAccessToken).toEqual(expect.any(String));
    expect(client.refreshToken).toEqual(expect.any(String));
    expect(client.refreshToken).not.toBe(firstRefreshToken);
    expect(tokenChanges).toHaveLength(2);
    expect(tokenChanges[1]).toEqual({
      accessToken: newAccessToken,
      refreshToken: client.refreshToken,
    });
  }, 30000);

  // the core OS-457 guarantee, exercised through the real published SDK:
  // reusing a rotated-out refresh token doesn't just fail that one request —
  // it kills the whole session, including the client that holds the
  // currently-valid, never-reused token from the same family
  it('reusing a rotated-out refresh token invalidates the whole session', async () => {
    const account = await insertAccount(db);
    const apiKey = await insertApiKey(db, { accountId: account.id });
    const client = new StorefrontClient(baseUrl, apiKey.key);

    await client.signUp({
      firstName: 'Reuse',
      lastName: 'Tester',
      email: `reuse-${account.id}@buyer.test`,
      password: 'a-real-password-123',
    });
    const staleRefreshToken = client.refreshToken;
    await client.refreshAccessToken(); // rotates — staleRefreshToken is now dead

    const attacker = new StorefrontClient(
      baseUrl,
      apiKey.key,
      undefined,
      staleRefreshToken,
    );
    await expect(attacker.refreshAccessToken()).resolves.toBeUndefined();

    // the legitimate client's own (never-reused) current token is also dead
    await expect(client.refreshAccessToken()).resolves.toBeUndefined();
  }, 30000);

  // OS-458: logout must actually revoke server-side, not just forget the
  // tokens locally — verified by having a second client try to use the same
  // refresh token afterward
  it('logout revokes the session server-side', async () => {
    const account = await insertAccount(db);
    const apiKey = await insertApiKey(db, { accountId: account.id });
    const tokenChanges: Array<{
      accessToken: string | undefined;
      refreshToken: string | undefined;
    }> = [];
    const client = new StorefrontClient(
      baseUrl,
      apiKey.key,
      undefined,
      undefined,
      { onTokensChanged: (tokens) => tokenChanges.push(tokens) },
    );

    await client.signUp({
      firstName: 'Logout',
      lastName: 'Tester',
      email: `logout-${account.id}@buyer.test`,
      password: 'a-real-password-123',
    });
    const issuedRefreshToken = client.refreshToken;

    await client.logout();

    expect(client.accessToken).toBeUndefined();
    expect(client.refreshToken).toBeUndefined();
    expect(tokenChanges.at(-1)).toEqual({
      accessToken: undefined,
      refreshToken: undefined,
    });

    // still-usable client-side memory of the old token proves nothing on
    // its own — confirm the server actually revoked it
    const rehydrated = new StorefrontClient(
      baseUrl,
      apiKey.key,
      undefined,
      issuedRefreshToken,
    );
    await expect(rehydrated.refreshAccessToken()).resolves.toBeUndefined();
  }, 30000);

  it('throws a typed ApiError with the real status on an invalid app key', async () => {
    const client = new StorefrontClient(baseUrl, 'sfk_not_a_real_key');

    await expect(
      client.cart.addItem({ variantId: 1, quantity: 1 }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      client.cart.addItem({ variantId: 1, quantity: 1 }),
    ).rejects.toBeInstanceOf(ApiError);

    // reads with no legitimate "empty" outcome — a bad app-key must surface
    // as ApiError, not silently look like an empty catalog/unready checkout
    await expect(client.products.list()).rejects.toMatchObject({ status: 401 });
    await expect(client.checkout.getConfig()).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      client.checkout.getShippingOptions({
        checkoutSessionId: 'cs_fake',
        shippingDetails: { name: 'x', address: { country: 'US' } },
      }),
    ).rejects.toMatchObject({ status: 401 });

    // reads with a genuine "empty" outcome (404) still throw for a bad
    // app-key — only their own specific expected status is swallowed
    await expect(client.products.getById(1)).rejects.toMatchObject({
      status: 401,
    });
    await expect(client.cart.get()).rejects.toMatchObject({ status: 401 });
    await expect(
      client.checkout.getSessionStatus('cs_fake'),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('returns undefined only for the one expected outcome, not any failure', async () => {
    const account = await insertAccount(db);
    const apiKey = await insertApiKey(db, { accountId: account.id });
    const client = new StorefrontClient(baseUrl, apiKey.key);

    // genuine 404s, with a valid app-key
    await expect(client.products.getById(999999)).resolves.toBeUndefined();
    await expect(client.cart.get()).resolves.toBeUndefined();
    // no connected Stripe account seeded for this test — getSessionStatus's
    // own NotFoundException branch for that fires before it ever looks up a
    // session id
    await expect(
      client.checkout.getSessionStatus('cs_fake'),
    ).resolves.toBeUndefined();

    // not currently signed in (no signUp/signIn called) — the 401 case
    await expect(client.customer.get()).resolves.toBeUndefined();
  });
});
