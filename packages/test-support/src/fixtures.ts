// Row builders for the Testcontainers Postgres — every spec that needs real
// data composes these instead of hand-writing inserts. Each returns the
// inserted row (ids included). Shapes mirror packages/seed/scripts/seed.ts.
import {
  accountApiKeysTable,
  accountsTable,
  and,
  brandsTable,
  cartItemsTable,
  cartsTable,
  categoriesTable,
  customersTable,
  eq,
  fulfillmentItemsTable,
  fulfillmentsTable,
  inArray,
  inventoryTable,
  isNull,
  locationsTable,
  orderItemsTable,
  orderShippingTable,
  orderPaymentsTable,
  orderRefundLinesTable,
  ordersTable,
  PERMISSIONS_CATALOG,
  permissionsTable,
  productCategoriesTable,
  productImagesTable,
  productOptionValuesTable,
  productOptionsTable,
  productsTable,
  productVariantsTable,
  rolePermissionsTable,
  rolesTable,
  stripeAccountsTable,
  userMfaRecoveryCodesTable,
  userMfaTable,
  userPasskeysTable,
  userRefreshTokensTable,
  userRolesTable,
  usersTable,
  variantOptionValuesTable,
  webauthnChallengesTable,
} from 'db';
import type { TestDb } from './test-db/db.js';

// Emailed links (Invite, password reset, email verification) are NOT seeded
// from here. Their digest has one definition, in merchant-api's Emailed
// links module, and a hand-copied second one lived at this spot until
// OS-509 — a fixture in the wrong encoding is a green suite that agrees
// with the bug. This package can't import an app, so the link builders
// moved next to that definition, in
// apps/merchant-api/src/identity/emailed-links/.

// TRUNCATE ... RESTART IDENTITY resets sequences per test, so a bare counter
// is enough to keep unique columns (emails, connected-account ids, SKUs,
// cart tokens) from colliding within one test.
let n = 0;
const uniq = () => `${++n}`;

type Row<T extends { $inferSelect: unknown }> = T['$inferSelect'];

async function one<T>(rows: T[]): Promise<T> {
  const [row] = rows;
  if (!row) throw new Error('fixture insert returned no row');
  return row;
}

export async function insertAccount(
  db: TestDb,
  over: { name?: string; phone?: string; email?: string } = {},
): Promise<Row<typeof accountsTable>> {
  return one(
    await db
      .insert(accountsTable)
      .values({
        name: over.name ?? 'Test Store',
        phone: over.phone ?? '5555550100',
        email: over.email ?? `owner-${uniq()}@store.test`,
      })
      .returning(),
  );
}

export async function insertUser(
  db: TestDb,
  opts: {
    accountId: number;
    firstname?: string;
    lastname?: string;
    email?: string;
    // omitted → null, which is what a user who never filled one in has
    phone?: string | null;
    // omitted → null (a still-pending invite, status 'invited'); pass any
    // string for a joined user (status 'active')
    password?: string | null;
    deactivatedAt?: Date | null;
    // omitted → null (unverified); pass a Date for an already-verified user
    emailVerifiedAt?: Date | null;
    // omitted → null (no per-user factor requirement, i.e. an owner); pass a
    // Date for a staff member who joined via an invite (OS-494)
    factorRequiredAt?: Date | null;
    // omitted → the column's random default, which is what real code always
    // relies on; pass one only to exercise the uniqueness constraint
    webauthnHandle?: string;
  },
): Promise<Row<typeof usersTable>> {
  return one(
    await db
      .insert(usersTable)
      .values({
        accountId: opts.accountId,
        firstname: opts.firstname ?? 'Staff',
        lastname: opts.lastname ?? `Member ${uniq()}`,
        email: opts.email ?? `staff-${uniq()}@store.test`,
        phone: opts.phone ?? null,
        password: opts.password ?? null,
        deactivatedAt: opts.deactivatedAt ?? null,
        emailVerifiedAt: opts.emailVerifiedAt ?? null,
        factorRequiredAt: opts.factorRequiredAt ?? null,
        ...(opts.webauthnHandle !== undefined && {
          webauthnHandle: opts.webauthnHandle,
        }),
      })
      .returning(),
  );
}

// An Account with one User in it, for specs about what the User can do
// rather than how they came to exist — seeded straight into the tables, not
// through signup. The options are the facts the sign-in and Session gates
// turn on, named for what they mean rather than for their columns:
//   emailVerified       omitted → verified (most specs aren't about the
//                       email gate); false → emailVerifiedAt NULL
//   accountRequiresMfa  the Account-wide Factor requirement (requireMfaAt)
//   factorRequiredAt    the per-User stamp an invited staff member carries
//   password            an already-hashed value; omitted → NULL, which is
//                       fine wherever nothing verifies it
export async function insertAccountWithUser(
  db: TestDb,
  opts: {
    emailVerified?: boolean;
    accountRequiresMfa?: boolean;
    factorRequiredAt?: Date;
    password?: string;
  } = {},
): Promise<{
  account: Row<typeof accountsTable>;
  user: Row<typeof usersTable>;
}> {
  let account = await insertAccount(db);
  if (opts.accountRequiresMfa) {
    account = await one(
      await db
        .update(accountsTable)
        .set({ requireMfaAt: new Date() })
        .where(eq(accountsTable.id, account.id))
        .returning(),
    );
  }
  const user = await insertUser(db, {
    accountId: account.id,
    password: opts.password ?? null,
    emailVerifiedAt: opts.emailVerified === false ? null : new Date(),
    factorRequiredAt: opts.factorRequiredAt ?? null,
  });
  return { account, user };
}

// Switches a User off the way UsersService.setDeactivated marks them — and
// nothing more: no Session is revoked. That is the point, for the specs that
// use it: they ask what the claim check or a sign-in path does with a
// deactivated User on its own.
export async function deactivateUser(db: TestDb, userId: number): Promise<void> {
  await db
    .update(usersTable)
    .set({ deactivatedAt: new Date() })
    .where(eq(usersTable.id, userId));
}

// How many refresh tokens this User could still redeem — i.e. how many
// Sessions they hold. Rows rather than behaviour, so only ever alongside a
// behavioural check, and for the invariants that can't be seen from outside:
// "exactly one live successor" after a race, or "rotated out" inside the
// refresh grace window, where presenting the old token replays its successor.
export async function liveRefreshTokenCount(
  db: TestDb,
  userId: number,
): Promise<number> {
  const rows = await db
    .select({ id: userRefreshTokensTable.id })
    .from(userRefreshTokensTable)
    .where(
      and(
        eq(userRefreshTokensTable.userId, userId),
        isNull(userRefreshTokensTable.revokedAt),
      ),
    );
  return rows.length;
}

// `secret` is stored pre-encrypted, same as the real table — this package
// has no dependency on merchant-api's encryption key, so a spec that needs
// to actually verify a TOTP code must encrypt a known secret itself (via
// merchant-api's own shared/mfa/mfa-crypto) and pass the result in here.
// Omitted → unconfirmed (mid-enrollment); pass a Date to simulate an
// already-activated factor.
export async function insertUserMfa(
  db: TestDb,
  opts: { userId: number; secret?: string; confirmedAt?: Date | null },
): Promise<Row<typeof userMfaTable>> {
  return one(
    await db
      .insert(userMfaTable)
      .values({
        userId: opts.userId,
        secret: opts.secret ?? `encrypted-secret-${uniq()}`,
        confirmedAt: opts.confirmedAt ?? null,
      })
      .returning(),
  );
}

// `codeHash` is stored pre-hashed, same as the real table — pass a real
// bcrypt hash to simulate a redeemable code. Omitted → unused; pass a Date
// to simulate an already-consumed one.
export async function insertUserMfaRecoveryCode(
  db: TestDb,
  opts: { userId: number; codeHash?: string; usedAt?: Date | null },
): Promise<Row<typeof userMfaRecoveryCodesTable>> {
  return one(
    await db
      .insert(userMfaRecoveryCodesTable)
      .values({
        userId: opts.userId,
        codeHash: opts.codeHash ?? `hash-${uniq()}`,
        usedAt: opts.usedAt ?? null,
      })
      .returning(),
  );
}

// A registered WebAuthn credential. `credentialId` and `publicKey` are
// opaque base64url blobs to everything except @simplewebauthn's verifier, so
// the defaults here are readable placeholders — a spec that actually
// verifies an assertion mocks the verifier rather than producing real
// attestation. `credentialId` is globally unique, so the default is
// uniquified.
export async function insertUserPasskey(
  db: TestDb,
  opts: {
    userId: number;
    credentialId?: string;
    publicKey?: string;
    counter?: number;
    nickname?: string;
    transports?: string[];
    deviceType?: string;
    backedUp?: boolean;
    lastUsedAt?: Date | null;
  },
): Promise<Row<typeof userPasskeysTable>> {
  return one(
    await db
      .insert(userPasskeysTable)
      .values({
        userId: opts.userId,
        credentialId: opts.credentialId ?? `credential-${uniq()}`,
        publicKey: opts.publicKey ?? `public-key-${uniq()}`,
        counter: opts.counter ?? 0,
        nickname: opts.nickname ?? 'Test passkey',
        transports: opts.transports ?? ['internal'],
        deviceType: opts.deviceType ?? 'multiDevice',
        backedUp: opts.backedUp ?? true,
        lastUsedAt: opts.lastUsedAt ?? null,
      })
      .returning(),
  );
}

// An in-flight WebAuthn ceremony nonce. Defaults to a live registration
// challenge five minutes out; pass a past `expiresAt` or a `consumedAt` to
// exercise the rejection paths, and `userId: null` for the usernameless
// sign-in ceremony, which has no known user until the credential comes back.
export async function insertWebauthnChallenge(
  db: TestDb,
  opts: {
    type: 'registration' | 'authentication';
    challenge?: string;
    userId?: number | null;
    expiresAt?: Date;
    consumedAt?: Date | null;
  },
): Promise<Row<typeof webauthnChallengesTable>> {
  return one(
    await db
      .insert(webauthnChallengesTable)
      .values({
        challenge: opts.challenge ?? `challenge-${uniq()}`,
        type: opts.type,
        userId: opts.userId ?? null,
        expiresAt: opts.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000),
        consumedAt: opts.consumedAt ?? null,
      })
      .returning(),
  );
}

// ── RBAC ────────────────────────────────────────────────────────────────────
// Testcontainers TRUNCATEs `permissions` per test, so a spec that exercises the
// PermissionsGuard / getEffectivePermissionKeys must seed the catalog first —
// mirrors PermissionsService.onModuleInit.
export async function seedPermissionsCatalog(db: TestDb): Promise<void> {
  await db
    .insert(permissionsTable)
    .values(PERMISSIONS_CATALOG)
    .onConflictDoNothing();
}

// Creates a role and links the given catalog keys (which must already be seeded
// via seedPermissionsCatalog). `permissionKeys` omitted → a role with no perms;
// pass the full catalog for an "owner-equivalent" custom role.
export async function insertRole(
  db: TestDb,
  opts: {
    accountId: number;
    name?: string;
    description?: string | null;
    isSystem?: boolean;
    permissionKeys?: string[];
  },
): Promise<Row<typeof rolesTable>> {
  const role = await one(
    await db
      .insert(rolesTable)
      .values({
        accountId: opts.accountId,
        name: opts.name ?? `Role ${uniq()}`,
        description: opts.description ?? null,
        isSystem: opts.isSystem ?? false,
      })
      .returning(),
  );
  if (opts.permissionKeys?.length) {
    const perms = await db
      .select({ id: permissionsTable.id })
      .from(permissionsTable)
      .where(inArray(permissionsTable.key, opts.permissionKeys));
    if (perms.length) {
      await db
        .insert(rolePermissionsTable)
        .values(perms.map((p) => ({ roleId: role.id, permissionId: p.id })));
    }
  }
  return role;
}

export async function assignRole(
  db: TestDb,
  opts: { userId: number; roleId: number },
): Promise<void> {
  await db
    .insert(userRolesTable)
    .values({ userId: opts.userId, roleId: opts.roleId })
    .onConflictDoNothing();
}

// account + user + a role holding exactly `permissionKeys`, all wired up.
// Seeds the catalog for you. Returns the ids a spec needs.
export async function insertUserWithPermissions(
  db: TestDb,
  opts: { accountId?: number; permissionKeys: string[] },
): Promise<{ accountId: number; userId: number; roleId: number }> {
  await seedPermissionsCatalog(db);
  const accountId = opts.accountId ?? (await insertAccount(db)).id;
  const user = await insertUser(db, { accountId });
  const role = await insertRole(db, {
    accountId,
    permissionKeys: opts.permissionKeys,
  });
  await assignRole(db, { userId: user.id, roleId: role.id });
  return { accountId, userId: user.id, roleId: role.id };
}

export async function insertApiKey(
  db: TestDb,
  opts: {
    accountId: number;
    key?: string;
    label?: string | null;
    // set → a revoked key (GET /api-keys and the storefront AppKeyGuard both
    // filter these out)
    revokedAt?: Date | null;
  },
): Promise<Row<typeof accountApiKeysTable>> {
  return one(
    await db
      .insert(accountApiKeysTable)
      .values({
        accountId: opts.accountId,
        key: opts.key ?? `sfk_test_${uniq()}`,
        label: opts.label ?? null,
        revokedAt: opts.revokedAt ?? null,
      })
      .returning(),
  );
}

export async function insertCustomer(
  db: TestDb,
  opts: {
    accountId: number;
    firstname?: string;
    lastname?: string;
    email?: string;
  },
): Promise<Row<typeof customersTable>> {
  return one(
    await db
      .insert(customersTable)
      .values({
        accountId: opts.accountId,
        firstname: opts.firstname ?? 'Shopper',
        lastname: opts.lastname ?? `Buyer ${uniq()}`,
        email: opts.email ?? `shopper-${uniq()}@buyer.test`,
        password: 'x',
      })
      .returning(),
  );
}

export async function insertStripeAccount(
  db: TestDb,
  opts: {
    accountId: number;
    chargesEnabled?: boolean;
    detailsSubmitted?: boolean;
    stripeAccountId?: string;
  },
): Promise<Row<typeof stripeAccountsTable>> {
  return one(
    await db
      .insert(stripeAccountsTable)
      .values({
        accountId: opts.accountId,
        stripeAccountId: opts.stripeAccountId ?? `acct_test_${uniq()}`,
        chargesEnabled: opts.chargesEnabled ?? true,
        detailsSubmitted: opts.detailsSubmitted ?? true,
      })
      .returning(),
  );
}

const DEFAULT_ADDRESS = {
  line1: '2261 Market Street',
  line2: '4242',
  city: 'San Francisco',
  state: 'CA',
  postalCode: '94114',
  country: 'US',
};

export async function insertLocation(
  db: TestDb,
  opts: {
    accountId: number;
    name?: string;
    // false → a location row with no shipping-origin address (the
    // "hasn't set up a shipping origin yet" path)
    withAddress?: boolean;
    address?: Partial<typeof DEFAULT_ADDRESS>;
  },
): Promise<Row<typeof locationsTable>> {
  const addr =
    opts.withAddress === false ? null : { ...DEFAULT_ADDRESS, ...opts.address };
  return one(
    await db
      .insert(locationsTable)
      .values({
        accountId: opts.accountId,
        name: opts.name ?? `Location ${uniq()}`,
        addressLine1: addr?.line1 ?? null,
        addressLine2: addr?.line2 ?? null,
        addressCity: addr?.city ?? null,
        addressState: addr?.state ?? null,
        addressPostalCode: addr?.postalCode ?? null,
        addressCountry: addr?.country ?? null,
      })
      .returning(),
  );
}

export async function insertBrand(
  db: TestDb,
  opts: { accountId: number; name?: string },
): Promise<Row<typeof brandsTable>> {
  return one(
    await db
      .insert(brandsTable)
      .values({ accountId: opts.accountId, name: opts.name ?? `Brand ${uniq()}` })
      .returning(),
  );
}

export async function insertCategory(
  db: TestDb,
  opts: { accountId: number; name?: string },
): Promise<Row<typeof categoriesTable>> {
  return one(
    await db
      .insert(categoriesTable)
      .values({
        accountId: opts.accountId,
        name: opts.name ?? `Category ${uniq()}`,
      })
      .returning(),
  );
}

export async function insertProduct(
  db: TestDb,
  opts: {
    accountId: number;
    name?: string;
    description?: string | null;
    status?: 'draft' | 'active' | 'archived';
    brandId?: number | null;
    categoryIds?: number[];
  },
): Promise<Row<typeof productsTable>> {
  const product = await one(
    await db
      .insert(productsTable)
      .values({
        accountId: opts.accountId,
        name: opts.name ?? `Product ${uniq()}`,
        description: opts.description ?? null,
        status: opts.status ?? 'active',
        brandId: opts.brandId ?? null,
      })
      .returning(),
  );
  if (opts.categoryIds?.length) {
    await db
      .insert(productCategoriesTable)
      .values(
        opts.categoryIds.map((categoryId) => ({
          productId: product.id,
          categoryId,
        })),
      );
  }
  return product;
}

export async function insertProductImage(
  db: TestDb,
  opts: {
    productId: number;
    variantId?: number | null;
    url?: string;
    position?: number;
  },
): Promise<Row<typeof productImagesTable>> {
  return one(
    await db
      .insert(productImagesTable)
      .values({
        productId: opts.productId,
        variantId: opts.variantId ?? null,
        key: `products/${opts.productId}/${uniq()}.jpg`,
        url: opts.url ?? `https://img.test/${opts.productId}-${uniq()}.jpg`,
        position: opts.position ?? 0,
      })
      .returning(),
  );
}

export interface VariantSpec {
  priceCents?: number;
  sku?: string | null;
  weightOz?: number | null;
  // "Size: 8" style label — creates the option/value/link rows so
  // ProductsService.selectVariants surfaces optionValues
  option?: { name: string; value: string };
  // stock per location: [{ locationId, stock }]
  stock?: { locationId: number; stock: number }[];
}

// Creates a product (unless productId given) plus one variant per spec, with
// option rows and inventory rows wired up. Returns the variant rows.
export async function insertProductWithVariants(
  db: TestDb,
  opts: {
    accountId: number;
    productId?: number;
    productName?: string;
    variants: VariantSpec[];
  },
): Promise<Row<typeof productVariantsTable>[]> {
  const productId =
    opts.productId ??
    (await insertProduct(db, { accountId: opts.accountId, name: opts.productName }))
      .id;

  const optionIdByName = new Map<string, number>();
  const out: Row<typeof productVariantsTable>[] = [];

  for (const spec of opts.variants) {
    const variant = await one(
      await db
        .insert(productVariantsTable)
        .values({
          productId,
          sku: spec.sku ?? null,
          priceCents: spec.priceCents ?? 10000,
          weightOz: spec.weightOz ?? null,
        })
        .returning(),
    );

    if (spec.option) {
      let optionId = optionIdByName.get(spec.option.name);
      if (optionId === undefined) {
        optionId = (
          await one(
            await db
              .insert(productOptionsTable)
              .values({ productId, name: spec.option.name })
              .returning(),
          )
        ).id;
        optionIdByName.set(spec.option.name, optionId);
      }
      const value = await one(
        await db
          .insert(productOptionValuesTable)
          .values({ optionId, value: spec.option.value })
          .returning(),
      );
      await db
        .insert(variantOptionValuesTable)
        .values({ variantId: variant.id, optionValueId: value.id });
    }

    if (spec.stock?.length) {
      await db.insert(inventoryTable).values(
        spec.stock.map((s) => ({
          variantId: variant.id,
          locationId: s.locationId,
          stock: s.stock,
        })),
      );
    }

    out.push(variant);
  }

  return out;
}

export async function insertInventory(
  db: TestDb,
  rows: { variantId: number; locationId: number; stock: number }[],
): Promise<void> {
  if (rows.length) await db.insert(inventoryTable).values(rows);
}

export async function insertCart(
  db: TestDb,
  opts: {
    accountId: number;
    token?: string;
    items?: { variantId: number; quantity: number }[];
  },
): Promise<Row<typeof cartsTable>> {
  const cart = await one(
    await db
      .insert(cartsTable)
      .values({
        accountId: opts.accountId,
        token: opts.token ?? `cart-tok-${uniq()}`,
      })
      .returning(),
  );
  if (opts.items?.length) {
    await db
      .insert(cartItemsTable)
      .values(
        opts.items.map((i) => ({
          cartId: cart.id,
          variantId: i.variantId,
          quantity: i.quantity,
        })),
      );
  }
  return cart;
}

export async function insertOrder(
  db: TestDb,
  opts: {
    accountId: number;
    channel?: 'web' | 'pos';
    status?:
      | 'pending'
      | 'paid'
      | 'partially_refunded'
      | 'refunded'
      | 'canceled'
      | 'payment_failed';
    customerEmail?: string | null;
    customerName?: string | null;
    customerId?: number | null;
    subtotalCents?: number;
    amountTotalCents?: number;
    shippingCents?: number;
    confirmationEmailQueuedAt?: Date | null;
  },
): Promise<Row<typeof ordersTable>> {
  return one(
    await db
      .insert(ordersTable)
      .values({
        accountId: opts.accountId,
        channel: opts.channel ?? 'web',
        status: opts.status ?? 'paid',
        customerEmail: opts.customerEmail ?? 'buyer@test.com',
        customerName: opts.customerName ?? 'Buyer',
        customerId: opts.customerId ?? null,
        subtotalCents: opts.subtotalCents ?? 1000,
        amountTotalCents: opts.amountTotalCents ?? 1000,
        shippingCents: opts.shippingCents ?? 0,
        confirmationEmailQueuedAt: opts.confirmationEmailQueuedAt ?? null,
      })
      .returning(),
  );
}

export async function insertOrderPayment(
  db: TestDb,
  opts: {
    orderId: number;
    method?: 'stripe' | 'cash' | 'card';
    amountCents?: number;
    stripeCheckoutSessionId?: string | null;
    stripePaymentIntentId?: string | null;
    // refund rows only
    stripeRefundId?: string | null;
    reason?: string | null;
    parentPaymentId?: number | null;
  },
): Promise<Row<typeof orderPaymentsTable>> {
  return one(
    await db
      .insert(orderPaymentsTable)
      .values({
        orderId: opts.orderId,
        method: opts.method ?? 'stripe',
        amountCents: opts.amountCents ?? 1000,
        stripeCheckoutSessionId: opts.stripeCheckoutSessionId ?? null,
        stripePaymentIntentId: opts.stripePaymentIntentId ?? null,
        stripeRefundId: opts.stripeRefundId ?? null,
        reason: opts.reason ?? null,
        parentPaymentId: opts.parentPaymentId ?? null,
      })
      .returning(),
  );
}

export async function insertOrderItem(
  db: TestDb,
  opts: {
    orderId: number;
    variantId?: number | null;
    productName?: string;
    sku?: string | null;
    optionsLabel?: string | null;
    priceCents?: number;
    quantity?: number;
    weightOz?: number | null;
  },
): Promise<Row<typeof orderItemsTable>> {
  return one(
    await db
      .insert(orderItemsTable)
      .values({
        orderId: opts.orderId,
        variantId: opts.variantId ?? null,
        productName: opts.productName ?? 'Item',
        sku: opts.sku ?? null,
        optionsLabel: opts.optionsLabel ?? null,
        priceCents: opts.priceCents ?? 1000,
        quantity: opts.quantity ?? 1,
        weightOz: opts.weightOz ?? null,
      })
      .returning(),
  );
}

export async function insertOrderShipping(
  db: TestDb,
  opts: {
    orderId: number;
    locationId?: number | null;
    line1?: string;
    line2?: string | null;
    city?: string;
    state?: string | null;
    postalCode?: string;
    country?: string;
  },
): Promise<Row<typeof orderShippingTable>> {
  const { orderId, locationId, ...address } = opts;
  return one(
    await db
      .insert(orderShippingTable)
      .values({
        orderId,
        locationId: locationId ?? null,
        ...DEFAULT_ADDRESS,
        ...address,
      })
      .returning(),
  );
}

// a purchased label plus the order-item quantities it covers
export async function insertFulfillment(
  db: TestDb,
  opts: {
    orderId: number;
    locationId: number;
    items: { orderItemId: number; quantity: number }[];
    shippingCarrier?: string | null;
    shippingServiceLevel?: string | null;
    trackingNumber?: string | null;
    trackingUrl?: string | null;
    labelUrl?: string | null;
    amountCents?: number;
  },
): Promise<Row<typeof fulfillmentsTable>> {
  const fulfillment = await one(
    await db
      .insert(fulfillmentsTable)
      .values({
        orderId: opts.orderId,
        locationId: opts.locationId,
        shippingCarrier: opts.shippingCarrier ?? 'USPS',
        shippingServiceLevel: opts.shippingServiceLevel ?? 'Priority Mail',
        trackingNumber: opts.trackingNumber ?? `TRACK${uniq()}`,
        trackingUrl: opts.trackingUrl ?? null,
        labelUrl: opts.labelUrl ?? null,
        amountCents: opts.amountCents ?? 850,
      })
      .returning(),
  );
  if (opts.items.length > 0) {
    await db.insert(fulfillmentItemsTable).values(
      opts.items.map((i) => ({
        fulfillmentId: fulfillment.id,
        orderItemId: i.orderItemId,
        quantity: i.quantity,
      })),
    );
  }
  return fulfillment;
}

// the per-line breakdown of a line-item refund — refundPaymentId is the
// negative order_payments row the refund was recorded as
export async function insertOrderRefundLine(
  db: TestDb,
  opts: { refundPaymentId: number; orderItemId: number; quantity: number },
): Promise<Row<typeof orderRefundLinesTable>> {
  return one(await db.insert(orderRefundLinesTable).values(opts).returning());
}
