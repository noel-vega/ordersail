// Seeds a demo sneaker store ("Sneaker Depot") with brands, categories, and
// products so local dev/testing never starts from an empty catalog. Each
// product's image is a real, specific photo of that shoe, read from
// seed-images/ (see download-seed-images.ts for where those come from).
// Re-runnable: every entity is looked up by its natural key before insert,
// so running this again only adds whatever's missing (e.g. new products
// appended to the list below) — it never duplicates existing rows.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { createStorageClient } from 'storage';
import {
  db,
  eq,
  and,
  sql,
  accountsTable,
  usersTable,
  locationsTable,
  accountApiKeysTable,
  brandsTable,
  categoriesTable,
  productsTable,
  productCategoriesTable,
  productOptionsTable,
  productOptionValuesTable,
  productVariantsTable,
  variantOptionValuesTable,
  productImagesTable,
  inventoryTable,
  permissionsTable,
  rolesTable,
  rolePermissionsTable,
  userRolesTable,
  PERMISSIONS_CATALOG,
  isUniqueViolation,
} from 'db';

const OWNER_EMAIL = 'owner@sneakerdepot.test';
const OWNER_PASSWORD = 'password123';

const BRANDS = ['Nike', 'Jordan', 'Adidas', 'Puma'] as const;

const CATEGORIES = ['Running', 'Basketball', 'Lifestyle', 'Retro'] as const;

const SHOE_SIZES = ['8', '9', '10', '11'] as const;

interface SeedVariant {
  optionValue?: string;
  priceCents: number;
  stock: number;
}

interface SeedProduct {
  name: string;
  description: string;
  brand: (typeof BRANDS)[number];
  categories: (typeof CATEGORIES)[number][];
  imageFile: string;
  optionName?: string;
  variants: SeedVariant[];
}

// every shoe gets the same 4 sizes at the same price — only the price and
// per-size stock differ per product
function shoeVariants(priceCents: number, stocks: [number, number, number, number]): SeedVariant[] {
  return SHOE_SIZES.map((optionValue, i) => ({ optionValue, priceCents, stock: stocks[i] }));
}

const PRODUCTS: SeedProduct[] = [
  {
    name: "Nike Air Force 1 '07",
    description: "The '82 basketball original, unchanged where it counts — crisp white leather on a padded collar.",
    brand: 'Nike',
    categories: ['Lifestyle'],
    imageFile: 'nike-air-force-1.jpg',
    optionName: 'Size',
    variants: shoeVariants(11500, [12, 18, 20, 9]),
  },
  {
    name: 'Nike Air Max 90',
    description: 'The visible Air unit that started it all, still riding on its original waffle-inspired outsole.',
    brand: 'Nike',
    categories: ['Lifestyle', 'Retro'],
    imageFile: 'nike-air-max-90.jpg',
    optionName: 'Size',
    variants: shoeVariants(13000, [10, 14, 16, 8]),
  },
  {
    name: 'Nike Dunk Low Retro "Varsity Green"',
    description: "Court-born color-blocking from the '80s, reissued in the green/white pairing collectors chase.",
    brand: 'Nike',
    categories: ['Lifestyle', 'Retro'],
    imageFile: 'nike-dunk-low-retro.jpg',
    optionName: 'Size',
    variants: shoeVariants(11000, [8, 12, 10, 6]),
  },
  {
    name: 'Nike React Infinity Run Flyknit 2',
    description: 'A wider base and a rocker shape built to keep easy miles easy, mile after mile.',
    brand: 'Nike',
    categories: ['Running'],
    imageFile: 'nike-react-infinity-run.jpg',
    optionName: 'Size',
    variants: shoeVariants(16000, [15, 20, 18, 10]),
  },
  {
    name: 'Air Jordan 1 Retro High OG',
    description: 'The silhouette that started the sneaker resale market, still riding high on and off the court.',
    brand: 'Jordan',
    categories: ['Basketball', 'Retro'],
    imageFile: 'air-jordan-1.jpg',
    optionName: 'Size',
    variants: shoeVariants(18000, [6, 10, 8, 4]),
  },
  {
    name: 'Air Jordan 4 Retro "White Cement"',
    description: 'Visible mesh panels and the iconic wing eyelets, in the colorway that defined the model.',
    brand: 'Jordan',
    categories: ['Basketball', 'Retro'],
    imageFile: 'air-jordan-4.jpg',
    optionName: 'Size',
    variants: shoeVariants(21000, [5, 9, 7, 3]),
  },
  {
    name: 'Air Jordan 11 Retro',
    description: "Patent leather mudguard and ballistic mesh upper — the pair Jordan wore to the '96 Finals.",
    brand: 'Jordan',
    categories: ['Basketball', 'Retro'],
    imageFile: 'air-jordan-11.jpg',
    optionName: 'Size',
    variants: shoeVariants(22500, [4, 7, 6, 2]),
  },
  {
    name: 'Adidas Ultraboost',
    description: 'A full-length Boost midsole under a Primeknit upper, tuned for all-day energy return.',
    brand: 'Adidas',
    categories: ['Running'],
    imageFile: 'adidas-ultraboost.jpg',
    optionName: 'Size',
    variants: shoeVariants(19000, [12, 16, 14, 8]),
  },
  {
    name: 'Adidas Stan Smith',
    description: "The tennis court original — clean white leather with a perforated three-stripe silhouette.",
    brand: 'Adidas',
    categories: ['Lifestyle'],
    imageFile: 'adidas-stan-smith.jpg',
    optionName: 'Size',
    variants: shoeVariants(10000, [14, 20, 18, 10]),
  },
  {
    name: 'Adidas Samba OG',
    description: "Originally built for indoor soccer training in the '50s, now a streetwear staple.",
    brand: 'Adidas',
    categories: ['Lifestyle', 'Retro'],
    imageFile: 'adidas-samba-og.jpg',
    optionName: 'Size',
    variants: shoeVariants(10000, [13, 17, 15, 9]),
  },
  {
    name: 'Adidas Gazelle',
    description: "A '68 terrace-culture classic in soft suede, sized down from its original training roots.",
    brand: 'Adidas',
    categories: ['Lifestyle', 'Retro'],
    imageFile: 'adidas-gazelle.jpg',
    optionName: 'Size',
    variants: shoeVariants(10000, [11, 15, 13, 7]),
  },
  {
    name: 'Puma Suede Classic',
    description: 'The 1968 basketball original that crossed over into hip-hop and skate culture alike.',
    brand: 'Puma',
    categories: ['Lifestyle', 'Retro'],
    imageFile: 'puma-suede-classic.jpg',
    optionName: 'Size',
    variants: shoeVariants(7500, [16, 22, 20, 12]),
  },
  {
    name: 'Puma Clyde',
    description: "Walt \"Clyde\" Frazier's 1973 signature shoe — soft suede on a low-profile court sole.",
    brand: 'Puma',
    categories: ['Basketball', 'Retro'],
    imageFile: 'puma-clyde.jpg',
    optionName: 'Size',
    variants: shoeVariants(10000, [9, 13, 11, 5]),
  },
];

function generateApiKey(): string {
  return `sfk_${randomBytes(24).toString('base64url')}`;
}

async function ensureAccount() {
  const [existingUser] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, OWNER_EMAIL));

  if (existingUser) {
    const [account] = await db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.id, existingUser.accountId));
    return account;
  }

  const hashedPassword = await bcrypt.hash(OWNER_PASSWORD, 10);
  return await db.transaction(async (tx) => {
    const [account] = await tx
      .insert(accountsTable)
      .values({ name: 'Sneaker Depot', phone: '5555550100', email: OWNER_EMAIL })
      .returning();

    await tx.insert(usersTable).values({
      accountId: account.id,
      firstname: 'Sneaker',
      lastname: 'Owner',
      email: OWNER_EMAIL,
      password: hashedPassword,
      // this is trusted local seed data, not a real signup — skip the
      // verify-email round trip and mark it proven up front so the demo
      // account isn't stuck behind the post-login verification gate (OS-470)
      emailVerifiedAt: new Date(),
    });

    return account;
  });
}

// mirrors PermissionsService.onModuleInit() in merchant-api — seed.ts
// runs standalone, so it can't rely on the API ever having booted
async function ensurePermissionsCatalog() {
  await db
    .insert(permissionsTable)
    .values(PERMISSIONS_CATALOG)
    .onConflictDoUpdate({
      target: permissionsTable.key,
      set: {
        resource: sql`excluded.resource`,
        action: sql`excluded.action`,
        description: sql`excluded.description`,
      },
    });
}

// mirrors RolesService.createSystemRole() in merchant-api
async function ensureOwnerRole(accountId: number, userId: number) {
  const findExisting = () =>
    db
      .select()
      .from(rolesTable)
      .where(and(eq(rolesTable.accountId, accountId), eq(rolesTable.isSystem, true)))
      .then(([row]) => row);

  const existing = await findExisting();
  if (existing) return existing;

  try {
    return await db.transaction(async (tx) => {
      const [role] = await tx
        .insert(rolesTable)
        .values({
          accountId,
          name: 'Owner',
          description: 'Full access to everything',
          isSystem: true,
        })
        .returning();

      const allPermissions = await tx.select({ id: permissionsTable.id }).from(permissionsTable);
      if (allPermissions.length > 0) {
        await tx
          .insert(rolePermissionsTable)
          .values(allPermissions.map((p) => ({ roleId: role.id, permissionId: p.id })));
      }

      await tx.insert(userRolesTable).values({ userId, roleId: role.id });
      return role;
    });
  } catch (err) {
    // two concurrent seed runs can both pass the check above before either
    // inserts — the (accountId, name) unique constraint lets one win
    if (isUniqueViolation(err)) {
      const existing = await findExisting();
      if (existing) return existing;
    }
    throw err;
  }
}

async function ensureDefaultLocation(accountId: number) {
  const [existing] = await db
    .select()
    .from(locationsTable)
    .where(and(eq(locationsTable.accountId, accountId), eq(locationsTable.name, 'Default')));
  if (existing) return existing;

  const [location] = await db
    .insert(locationsTable)
    .values({
      accountId,
      name: 'Default',
      // a real ship-from origin so web checkout can fetch Shippo rates without
      // a manual Locations step (see docs/runbooks/web-checkout.md)
      addressLine1: '2261 Market Street',
      addressLine2: '4242',
      addressCity: 'San Francisco',
      addressState: 'CA',
      addressPostalCode: '94114',
      addressCountry: 'US',
    })
    .returning();
  return location;
}

async function ensureApiKey(accountId: number) {
  const [existing] = await db
    .select()
    .from(accountApiKeysTable)
    .where(eq(accountApiKeysTable.accountId, accountId));
  if (existing) return existing;

  const [key] = await db
    .insert(accountApiKeysTable)
    .values({ accountId, key: generateApiKey(), label: 'Seed default' })
    .returning();
  console.log(`Created storefront API key: ${key.key}`);
  return key;
}

async function ensureBrands(accountId: number) {
  const map = new Map<string, number>();
  for (const name of BRANDS) {
    const [existing] = await db
      .select()
      .from(brandsTable)
      .where(and(eq(brandsTable.accountId, accountId), eq(brandsTable.name, name)));
    if (existing) {
      map.set(name, existing.id);
      continue;
    }
    const [brand] = await db.insert(brandsTable).values({ accountId, name }).returning();
    map.set(name, brand.id);
  }
  return map;
}

async function ensureCategories(accountId: number) {
  const map = new Map<string, number>();
  for (const name of CATEGORIES) {
    const [existing] = await db
      .select()
      .from(categoriesTable)
      .where(and(eq(categoriesTable.accountId, accountId), eq(categoriesTable.name, name)));
    if (existing) {
      map.set(name, existing.id);
      continue;
    }
    const [category] = await db.insert(categoriesTable).values({ accountId, name }).returning();
    map.set(name, category.id);
  }
  return map;
}

// returns the product's id either way — the caller uses this to backfill
// images for products that already existed from a previous seed run
async function ensureProduct(
  product: SeedProduct,
  accountId: number,
  locationId: number,
  brandsByName: Map<string, number>,
  categoriesByName: Map<string, number>,
): Promise<{ id: number; created: boolean }> {
  const [existing] = await db
    .select({ id: productsTable.id })
    .from(productsTable)
    .where(and(eq(productsTable.accountId, accountId), eq(productsTable.name, product.name)));
  if (existing) return { id: existing.id, created: false };

  const productId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(productsTable)
      .values({
        accountId,
        name: product.name,
        description: product.description,
        status: 'active',
        brandId: brandsByName.get(product.brand) ?? null,
      })
      .returning();

    if (product.categories.length > 0) {
      await tx.insert(productCategoriesTable).values(
        product.categories.map((name) => ({
          productId: row.id,
          categoryId: categoriesByName.get(name)!,
        })),
      );
    }

    const optionValueIdByValue = new Map<string, number>();
    if (product.optionName) {
      const [option] = await tx
        .insert(productOptionsTable)
        .values({ productId: row.id, name: product.optionName })
        .returning();

      const values = [
        ...new Set(product.variants.map((v) => v.optionValue).filter((v): v is string => !!v)),
      ];
      for (const value of values) {
        const [optionValue] = await tx
          .insert(productOptionValuesTable)
          .values({ optionId: option.id, value })
          .returning();
        optionValueIdByValue.set(value, optionValue.id);
      }
    }

    for (const variant of product.variants) {
      const [variantRow] = await tx
        .insert(productVariantsTable)
        // a shoe + box is ~2 lb — gives Shippo something realistic to quote
        // instead of the 16 oz per-unit fallback
        .values({ productId: row.id, priceCents: variant.priceCents, weightOz: 32 })
        .returning();

      const optionValueId = variant.optionValue
        ? optionValueIdByValue.get(variant.optionValue)
        : undefined;
      if (optionValueId) {
        await tx
          .insert(variantOptionValuesTable)
          .values({ variantId: variantRow.id, optionValueId });
      }

      await tx
        .insert(inventoryTable)
        .values({ variantId: variantRow.id, locationId, stock: variant.stock });
    }

    return row.id;
  });

  return { id: productId, created: true };
}

const SEED_IMAGES_DIR = path.join(import.meta.dirname, 'seed-images');

async function ensureProductImage(
  storage: ReturnType<typeof createStorageClient>,
  productId: number,
  imageFile: string,
): Promise<boolean> {
  const [existing] = await db
    .select({ id: productImagesTable.id })
    .from(productImagesTable)
    .where(eq(productImagesTable.productId, productId));
  if (existing) return false;

  const bytes = await readFile(path.join(SEED_IMAGES_DIR, imageFile));
  const contentType = 'image/jpeg'; // every file in seed-images/ is a re-encoded JPEG

  const key = `products/${productId}/${randomBytes(8).toString('hex')}.jpg`;
  const uploadUrl = await storage.getUploadUrl(key, contentType);
  await fetch(uploadUrl, {
    method: 'PUT',
    body: bytes,
    headers: { 'Content-Type': contentType },
  });

  await db.insert(productImagesTable).values({
    productId,
    variantId: null,
    key,
    url: storage.getPublicUrl(key),
    position: 0,
  });

  return true;
}

async function main() {
  console.log('Seeding Sneaker Depot demo data...');

  const storage = createStorageClient({
    endpoint: process.env.MINIO_ENDPOINT ?? 'http://localhost:9000',
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
    bucket: process.env.MINIO_BUCKET ?? 'ordersail-product-images',
    forcePathStyle: process.env.MINIO_FORCE_PATH_STYLE !== 'false',
    publicBaseUrl: process.env.MINIO_PUBLIC_BASE_URL ?? 'http://localhost:9000/ordersail-product-images',
  });
  await storage.ensureBucket();

  await ensurePermissionsCatalog();

  const account = await ensureAccount();
  const [owner] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, OWNER_EMAIL));
  await ensureOwnerRole(account.id, owner.id);

  const location = await ensureDefaultLocation(account.id);
  await ensureApiKey(account.id);

  const brandsByName = await ensureBrands(account.id);
  const categoriesByName = await ensureCategories(account.id);

  let created = 0;
  let skipped = 0;
  let imagesAdded = 0;
  for (const product of PRODUCTS) {
    const { id, created: didCreate } = await ensureProduct(
      product,
      account.id,
      location.id,
      brandsByName,
      categoriesByName,
    );
    if (didCreate) created++;
    else skipped++;

    if (await ensureProductImage(storage, id, product.imageFile)) imagesAdded++;
  }

  console.log(`Done. ${created} product(s) created, ${skipped} already existed.`);
  console.log(`${imagesAdded} product image(s) added.`);
  console.log(`Sign in at merchant-web with ${OWNER_EMAIL} / ${OWNER_PASSWORD}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
