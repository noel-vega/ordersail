// Replaces storefront-web's implicit role as storefront-api's only
// consumer-contract check (OS-425). storefront-web building/typechecking
// against generated types only ever caught a *type-level* break; this spins
// up the real app over real HTTP and drives it through the actual published
// SDK client, catching runtime contract breaks (status codes, response
// shapes, auth behavior) too. Required before M2 can remove storefront-web
// from this monorepo/CI without losing coverage.
import type { AddressInfo } from 'node:net';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test, TestingModule } from '@nestjs/testing';
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
import {
  ApiError,
  StorefrontClient,
  type StorefrontClientOptions,
} from '@ordersail/storefront-sdk';
import { configureApp } from '../configure-app';
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
  let app: NestFastifyApplication;
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

    // the same configureApp as main.ts (minus CORS, which only a browser
    // enforces, and Swagger, which nothing here reads)
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    configureApp(app);
    await app.init();
    await app.listen(0, '127.0.0.1');
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

  // OS-690: a client restored from a stored refresh token has no access
  // token, so its first authenticated calls all 401 at once. Each used to
  // refresh on its own with the same single-use token — the second
  // redemption looks like reuse (above) and signs the customer out.
  describe('concurrent refresh (single-flight)', () => {
    let fetchSpy: jest.SpiedFunction<typeof fetch> | undefined;

    afterEach(() => {
      fetchSpy?.mockRestore();
      fetchSpy = undefined;
    });

    // Wraps the real fetch so a test can count — and perturb — what the SDK
    // actually sends. openapi-fetch captures globalThis.fetch when the
    // client is constructed, so call this before `new StorefrontClient()`.
    function spyOnFetch(
      intercept?: (
        path: string,
        send: () => Promise<Response>,
      ) => Promise<Response>,
    ) {
      const realFetch = globalThis.fetch;
      const paths: string[] = [];
      fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockImplementation((input, init) => {
          const url = input instanceof Request ? input.url : input.toString();
          const path = new URL(url).pathname;
          paths.push(path);
          const send = () => realFetch(input, init);
          return intercept ? intercept(path, send) : send();
        });
      return {
        refreshCount: () =>
          paths.filter((path) => path === '/v1/auth/token/refresh').length,
      };
    }

    async function waitFor(condition: () => boolean, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitFor timed out');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    // a live session's refresh token, as a storefront would restore it from
    // storage on page load
    async function restoredSession(label: string) {
      const account = await insertAccount(db);
      const apiKey = await insertApiKey(db, { accountId: account.id });
      const signedIn = new StorefrontClient(baseUrl, apiKey.key);
      const email = `${label}-${account.id}@buyer.test`;
      await signedIn.signUp({
        firstName: 'Concurrent',
        lastName: 'Tester',
        email,
        password: 'a-real-password-123',
      });
      return { appKey: apiKey.key, refreshToken: signedIn.refreshToken, email };
    }

    // call after spyOnFetch() — openapi-fetch captures fetch at construction
    function restoredClient(
      session: { appKey: string; refreshToken: string | undefined },
      options?: StorefrontClientOptions,
    ) {
      return new StorefrontClient(
        baseUrl,
        session.appKey,
        undefined,
        session.refreshToken,
        options,
      );
    }

    // holds every refresh response until release() — the server has already
    // rotated by the time refreshLanded() is true, but the client hasn't
    // applied it yet. issuedRefreshTokens() is what the server minted, read
    // off the wire, whether or not the client ends up keeping it.
    function holdRefresh() {
      let landed = false;
      const issued: string[] = [];
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const fetches = spyOnFetch(async (path, send) => {
        const response = await send();
        if (path === '/v1/auth/token/refresh') {
          const body = (await response.clone().json()) as {
            refresh_token?: string;
          };
          if (body.refresh_token) issued.push(body.refresh_token);
          landed = true;
          await released;
        }
        return response;
      });
      return {
        ...fetches,
        refreshLanded: () => landed,
        issuedRefreshTokens: () => issued,
        release,
      };
    }

    it('concurrent 401s share one refresh and the session survives', async () => {
      const session = await restoredSession('concurrent');
      const fetches = spyOnFetch();
      const client = restoredClient(session);

      const [customer, orders, sameOrders] = await Promise.all([
        client.customer.get(),
        client.customer.orders.list(),
        client.customer.orders.list(),
      ]);

      expect(customer?.email).toBe(session.email);
      expect(orders.total).toBe(0);
      expect(sameOrders.total).toBe(0);
      expect(fetches.refreshCount()).toBe(1);
      // a reuse-revoked family would make this undefined
      await expect(client.refreshAccessToken()).resolves.toEqual(
        expect.any(String),
      );
    }, 30000);

    it('a 401 that lands after the refresh retries with the new token instead of rotating again', async () => {
      const session = await restoredSession('late');
      let heldOnce = false;
      const fetches = spyOnFetch(async (path, send) => {
        const response = await send();
        // hold customer.get()'s 401 until the other call's refresh has
        // fully landed on the client
        if (path === '/v1/customer' && !heldOnce) {
          heldOnce = true;
          await waitFor(() => client.accessToken !== undefined);
        }
        return response;
      });
      // only read by the interceptor once requests start, after this runs
      const client = restoredClient(session);

      const [customer, orders] = await Promise.all([
        client.customer.get(),
        client.customer.orders.list(),
      ]);

      expect(customer?.email).toBe(session.email);
      expect(orders.total).toBe(0);
      expect(fetches.refreshCount()).toBe(1);
    }, 30000);

    it('a failed refresh rejects every waiting caller, and the next call refreshes again', async () => {
      const session = await restoredSession('flaky');
      let failNextRefresh = true;
      let unauthorized = 0;
      const fetches = spyOnFetch(async (path, send) => {
        if (path === '/v1/auth/token/refresh' && failNextRefresh) {
          failNextRefresh = false;
          // fail only once all three callers' 401s are back, so all three
          // are waiting on this one refresh rather than starting their own
          await waitFor(() => unauthorized >= 3);
          throw new TypeError('fetch failed');
        }
        const response = await send();
        if (response.status === 401) unauthorized++;
        return response;
      });
      const client = restoredClient(session);

      const results = await Promise.allSettled([
        client.customer.get(),
        client.customer.orders.list(),
        client.customer.orders.list(),
      ]);

      expect(results.map((result) => result.status)).toEqual([
        'rejected',
        'rejected',
        'rejected',
      ]);
      expect(fetches.refreshCount()).toBe(1);

      // the failed attempt never reached the server, so the token is still
      // good — and the rejected refresh mustn't be handed out again
      await expect(client.customer.get()).resolves.toMatchObject({
        email: session.email,
      });
      expect(fetches.refreshCount()).toBe(2);
    }, 30000);

    it('an invalid refresh token is refreshed once and every caller sees signed-out', async () => {
      const account = await insertAccount(db);
      const apiKey = await insertApiKey(db, { accountId: account.id });
      const fetches = spyOnFetch();
      const client = restoredClient({
        appKey: apiKey.key,
        refreshToken: 'not-a-real-refresh-token',
      });

      const [customer, orders] = await Promise.allSettled([
        client.customer.get(),
        client.customer.orders.list(),
      ]);

      expect(customer).toEqual({ status: 'fulfilled', value: undefined });
      expect(orders).toMatchObject({
        status: 'rejected',
        reason: { status: 401 },
      });
      expect(fetches.refreshCount()).toBe(1);
      expect(client.refreshToken).toBeUndefined();
    }, 30000);

    it('logout() while a refresh is in flight stays logged out when it lands', async () => {
      const session = await restoredSession('logout-race');
      const fetches = holdRefresh();
      const emitted: (string | undefined)[] = [];
      const client = restoredClient(session, {
        onTokensChanged: ({ accessToken }) => emitted.push(accessToken),
      });

      const pending = client.customer.get();
      await waitFor(fetches.refreshLanded);
      await client.logout();
      fetches.release();

      await expect(pending).resolves.toBeUndefined();
      expect(client.accessToken).toBeUndefined();
      expect(client.refreshToken).toBeUndefined();
      // logout's clear is the last thing persisted — the stale refresh
      // never wrote its tokens back
      expect(emitted).toEqual([undefined]);
      // and nothing is left to refresh with
      await expect(client.refreshAccessToken()).resolves.toBeUndefined();
      expect(fetches.refreshCount()).toBe(1);

      // the server rotated before logout ran, so the discarded refresh
      // minted a real token — logout (presenting the rotated-out one) must
      // have revoked its whole family, or that token is a live orphan
      const [minted] = fetches.issuedRefreshTokens();
      expect(minted).toEqual(expect.any(String));
      const replay = restoredClient({
        appKey: session.appKey,
        refreshToken: minted,
      });
      await expect(replay.refreshAccessToken()).resolves.toBeUndefined();
    }, 30000);

    it('signIn() while a refresh is in flight keeps the signed-in session', async () => {
      const session = await restoredSession('signin-race');
      const fetches = holdRefresh();
      const client = restoredClient(session);

      const pending = client.customer.get();
      await waitFor(fetches.refreshLanded);
      const signedInToken = await client.signIn({
        email: session.email,
        password: 'a-real-password-123',
      });
      const signedInRefreshToken = client.refreshToken;
      fetches.release();

      await expect(pending).resolves.toMatchObject({ email: session.email });
      expect(client.accessToken).toBe(signedInToken);
      expect(client.refreshToken).toBe(signedInRefreshToken);
      // the next refresh starts fresh against the signed-in session rather
      // than joining the superseded one
      await expect(client.refreshAccessToken()).resolves.toEqual(
        expect.any(String),
      );
      expect(fetches.refreshCount()).toBe(2);
    }, 30000);
  });

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

  // ADR 0001: a bad app key is a misconfiguration a refresh can't fix, so the
  // client reports it by code and never spends a refresh on it — even with a
  // session it could have refreshed, and even on a read whose expected
  // "empty" outcome is a 401
  it('reports a bad app key as invalid_app_key and never tries a refresh', async () => {
    const account = await insertAccount(db);
    const apiKey = await insertApiKey(db, { accountId: account.id });
    const signedIn = new StorefrontClient(baseUrl, apiKey.key);
    await signedIn.signUp({
      firstName: 'Bad',
      lastName: 'Key',
      email: `bad-key-${account.id}@buyer.test`,
      password: 'a-real-password-123',
    });

    const paths: string[] = [];
    const realFetch = globalThis.fetch;
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        paths.push(new URL(url).pathname);
        return realFetch(input, init);
      });
    try {
      const client = new StorefrontClient(
        baseUrl,
        'sfk_not_a_real_key',
        undefined,
        signedIn.refreshToken,
      );
      client.accessToken = signedIn.accessToken;

      const ordersError = await client.customer.orders
        .list()
        .catch((err: unknown) => err);
      expect(ordersError).toBeInstanceOf(ApiError);
      expect(ordersError).toMatchObject({
        status: 401,
        code: 'invalid_app_key',
        type: 'authentication_error',
      });
      await expect(client.customer.get()).rejects.toMatchObject({
        code: 'invalid_app_key',
      });
      expect(paths).not.toContain('/v1/auth/token/refresh');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('reports a bad request body as validation_failed with the field at fault', async () => {
    const account = await insertAccount(db);
    const apiKey = await insertApiKey(db, { accountId: account.id });
    const client = new StorefrontClient(baseUrl, apiKey.key);

    const error = await client.cart
      .addItem({ variantId: 1, quantity: 0 })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: 'validation_failed',
      param: 'quantity',
    });
    const fields = (error as ApiError).details?.fields as
      { param: string; message: string }[] | undefined;
    expect(fields?.map((field) => field.param)).toEqual(['quantity']);
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

  // The SDK reaches every route via its generated /v1 paths, so the tests above
  // already prove the prefixed routes work. These pin the other half: nothing
  // public is served unversioned, and /health (ALB / ECS / smoke-test probes)
  // is the one exception (OS-714).
  it('serves the API only under /v1, with /health left unversioned', async () => {
    const status = async (path: string) =>
      (await fetch(`${baseUrl}${path}`)).status;

    expect(await status('/v1/products')).toBe(401); // routed, needs an app key
    expect(await status('/products')).toBe(404);
    expect(await status('/v1/health')).toBe(404);
    // 200 or 503 depending on whether Redis is reachable here — either way
    // the route exists, which is all this asserts
    expect(await status('/health')).not.toBe(404);
  });
});
