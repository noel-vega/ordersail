// Row builders for the Testcontainers Postgres — every spec that needs real
// data composes these instead of hand-writing inserts. Each returns the
// inserted row (ids included). Shapes mirror packages/seed/scripts/seed.ts.
import {
  accountApiKeysTable,
  accountsTable,
  brandsTable,
  cartItemsTable,
  cartsTable,
  categoriesTable,
  customersTable,
  inArray,
  inventoryTable,
  locationsTable,
  orderItemsTable,
  orderPaymentsTable,
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
  userRolesTable,
  usersTable,
  variantOptionValuesTable,
} from 'db';
import type { TestDb } from './test-db/db.js';

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
