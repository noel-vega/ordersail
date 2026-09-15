import { Test, TestingModule } from '@nestjs/testing';
import {
  insertAccount,
  insertBrand,
  insertCategory,
  insertLocation,
  insertProduct,
  insertProductImage,
  insertProductWithVariants,
  useTestDb,
} from 'test-support';
import { productBarcodesTable } from 'db';
import { ProductsService } from './products.service';
import { DRIZZLE } from '../../database/database.constants';

const db = useTestDb();

async function build() {
  const module: TestingModule = await Test.createTestingModule({
    providers: [ProductsService, { provide: DRIZZLE, useValue: db }],
  }).compile();
  return module.get<ProductsService>(ProductsService);
}

describe('ProductsService', () => {
  it('is defined', async () => {
    expect(await build()).toBeDefined();
  });

  it('returns an empty page when the account has no products', async () => {
    const account = await insertAccount(db);
    const service = await build();

    const result = await service.findAll({ limit: 20, offset: 0 }, account.id);

    expect(result).toEqual({ items: [], total: 0, limit: 20, offset: 0 });
  });

  it('attaches brand and categories and derives the price range', async () => {
    const account = await insertAccount(db);
    const brand = await insertBrand(db, {
      accountId: account.id,
      name: 'Acme',
    });
    const category = await insertCategory(db, {
      accountId: account.id,
      name: 'Footwear',
    });
    const product = await insertProduct(db, {
      accountId: account.id,
      name: 'Shoe',
      description: 'A shoe',
      brandId: brand.id,
      categoryIds: [category.id],
    });
    await insertProductWithVariants(db, {
      accountId: account.id,
      productId: product.id,
      variants: [{ priceCents: 1000 }, { priceCents: 2000 }],
    });
    await insertProductImage(db, {
      productId: product.id,
      url: 'https://img/shoe.jpg',
    });
    const service = await build();

    const result = await service.findAll({ limit: 20, offset: 0 }, account.id);

    expect(result).toEqual({
      items: [
        {
          id: product.id,
          name: 'Shoe',
          description: 'A shoe',
          brand: { id: brand.id, name: 'Acme' },
          categories: [{ id: category.id, name: 'Footwear' }],
          thumbnailUrl: 'https://img/shoe.jpg',
          minPriceCents: 1000,
          maxPriceCents: 2000,
        },
      ],
      total: 1,
      limit: 20,
      offset: 0,
    });
  });

  it('leaves brand null and the price range null for a bare product', async () => {
    const account = await insertAccount(db);
    await insertProduct(db, { accountId: account.id, name: 'Shoe' });
    const service = await build();

    const result = await service.findAll({ limit: 20, offset: 0 }, account.id);

    expect(result.items[0]).toMatchObject({
      brand: null,
      categories: [],
      thumbnailUrl: null,
      minPriceCents: null,
      maxPriceCents: null,
    });
  });

  it('excludes another account and non-active products from the page', async () => {
    const mine = await insertAccount(db);
    const theirs = await insertAccount(db);
    await insertProduct(db, {
      accountId: mine.id,
      name: 'Active',
      status: 'active',
    });
    await insertProduct(db, {
      accountId: mine.id,
      name: 'Draft',
      status: 'draft',
    });
    await insertProduct(db, { accountId: theirs.id, name: 'Not mine' });
    const service = await build();

    const result = await service.findAll({ limit: 20, offset: 0 }, mine.id);

    expect(result.total).toBe(1);
    expect(result.items.map((i) => i.name)).toEqual(['Active']);
  });

  // the not-found path the controller maps to 404: unknown id, wrong tenant,
  // or a draft/archived product
  it('findOne returns undefined when no active product matches the id/account', async () => {
    const account = await insertAccount(db);
    const service = await build();

    expect(await service.findOne(999, account.id)).toBeUndefined();
  });

  describe('q (text search)', () => {
    it('matches on name, case-insensitively', async () => {
      const account = await insertAccount(db);
      await insertProduct(db, {
        accountId: account.id,
        name: 'Trail Runner',
      });
      await insertProduct(db, { accountId: account.id, name: 'Backpack' });
      const service = await build();

      const byName = await service.findAll(
        { limit: 20, offset: 0, q: 'trail' },
        account.id,
      );
      expect(byName.items.map((i) => i.name)).toEqual(['Trail Runner']);
    });

    it('does not match on description', async () => {
      const account = await insertAccount(db);
      await insertProduct(db, {
        accountId: account.id,
        name: 'Umbrella',
        description: 'Keeps you dry on the trail',
      });
      const service = await build();

      const result = await service.findAll(
        { limit: 20, offset: 0, q: 'trail' },
        account.id,
      );
      expect(result.items).toEqual([]);
    });

    it('matches on a variant SKU without narrowing the price range to only the matching variant', async () => {
      const account = await insertAccount(db);
      const product = await insertProduct(db, {
        accountId: account.id,
        name: 'Shoe',
      });
      await insertProductWithVariants(db, {
        accountId: account.id,
        productId: product.id,
        variants: [
          { sku: 'SHOE-RED-9', priceCents: 1000 },
          { sku: 'SHOE-BLUE-9', priceCents: 2000 },
        ],
      });
      const service = await build();

      const result = await service.findAll(
        { limit: 20, offset: 0, q: 'red-9' },
        account.id,
      );

      expect(result.items).toEqual([
        expect.objectContaining({
          id: product.id,
          minPriceCents: 1000,
          maxPriceCents: 2000,
        }),
      ]);
    });

    it('matches on a variant barcode', async () => {
      const account = await insertAccount(db);
      const product = await insertProduct(db, {
        accountId: account.id,
        name: 'Shoe',
      });
      const [variant] = await insertProductWithVariants(db, {
        accountId: account.id,
        productId: product.id,
        variants: [{ priceCents: 1000 }],
      });
      await db
        .insert(productBarcodesTable)
        .values({ variantId: variant.id, code: '012345678905' });
      const service = await build();

      const result = await service.findAll(
        { limit: 20, offset: 0, q: '012345678905' },
        account.id,
      );

      expect(result.items.map((i) => i.id)).toEqual([product.id]);
    });

    it('returns no items when nothing matches', async () => {
      const account = await insertAccount(db);
      await insertProduct(db, { accountId: account.id, name: 'Shoe' });
      const service = await build();

      const result = await service.findAll(
        { limit: 20, offset: 0, q: 'nonexistent' },
        account.id,
      );

      expect(result).toMatchObject({ items: [], total: 0 });
    });

    it('treats a blank q the same as no filter', async () => {
      const account = await insertAccount(db);
      await insertProduct(db, { accountId: account.id, name: 'Shoe' });
      const service = await build();

      const result = await service.findAll(
        { limit: 20, offset: 0, q: '   ' },
        account.id,
      );

      expect(result.total).toBe(1);
    });
  });

  describe('filters', () => {
    it('filters by categoryId', async () => {
      const account = await insertAccount(db);
      const shoes = await insertCategory(db, { accountId: account.id });
      const hats = await insertCategory(db, { accountId: account.id });
      await insertProduct(db, {
        accountId: account.id,
        name: 'Shoe',
        categoryIds: [shoes.id],
      });
      await insertProduct(db, {
        accountId: account.id,
        name: 'Hat',
        categoryIds: [hats.id],
      });
      const service = await build();

      const result = await service.findAll(
        { limit: 20, offset: 0, categoryId: shoes.id },
        account.id,
      );

      expect(result.items.map((i) => i.name)).toEqual(['Shoe']);
    });

    it('filters by brandId', async () => {
      const account = await insertAccount(db);
      const acme = await insertBrand(db, { accountId: account.id });
      const other = await insertBrand(db, { accountId: account.id });
      await insertProduct(db, {
        accountId: account.id,
        name: 'Acme Shoe',
        brandId: acme.id,
      });
      await insertProduct(db, {
        accountId: account.id,
        name: 'Other Shoe',
        brandId: other.id,
      });
      const service = await build();

      const result = await service.findAll(
        { limit: 20, offset: 0, brandId: acme.id },
        account.id,
      );

      expect(result.items.map((i) => i.name)).toEqual(['Acme Shoe']);
    });

    it('filters by price range without narrowing the price range of a matching product', async () => {
      const account = await insertAccount(db);
      const cheap = await insertProduct(db, {
        accountId: account.id,
        name: 'Cheap',
      });
      await insertProductWithVariants(db, {
        accountId: account.id,
        productId: cheap.id,
        variants: [{ priceCents: 500 }, { priceCents: 5000 }],
      });
      const expensive = await insertProduct(db, {
        accountId: account.id,
        name: 'Expensive',
      });
      await insertProductWithVariants(db, {
        accountId: account.id,
        productId: expensive.id,
        variants: [{ priceCents: 9000 }],
      });
      const service = await build();

      // matches "Cheap" via its 500-cent variant, even though it also has a
      // 5000-cent variant outside the range
      const result = await service.findAll(
        { limit: 20, offset: 0, minPriceCents: 100, maxPriceCents: 1000 },
        account.id,
      );

      expect(result.items).toEqual([
        expect.objectContaining({
          name: 'Cheap',
          minPriceCents: 500,
          maxPriceCents: 5000,
        }),
      ]);
    });

    it('filters by inStock', async () => {
      const account = await insertAccount(db);
      const location = await insertLocation(db, { accountId: account.id });
      const inStock = await insertProduct(db, {
        accountId: account.id,
        name: 'In stock',
      });
      await insertProductWithVariants(db, {
        accountId: account.id,
        productId: inStock.id,
        variants: [{ stock: [{ locationId: location.id, stock: 5 }] }],
      });
      const outOfStock = await insertProduct(db, {
        accountId: account.id,
        name: 'Out of stock',
      });
      await insertProductWithVariants(db, {
        accountId: account.id,
        productId: outOfStock.id,
        variants: [{ stock: [{ locationId: location.id, stock: 0 }] }],
      });
      const noInventoryRow = await insertProduct(db, {
        accountId: account.id,
        name: 'No inventory row',
      });
      await insertProductWithVariants(db, {
        accountId: account.id,
        productId: noInventoryRow.id,
        variants: [{}],
      });
      const service = await build();

      const result = await service.findAll(
        { limit: 20, offset: 0, inStock: true },
        account.id,
      );

      expect(result.items.map((i) => i.name)).toEqual(['In stock']);
    });

    it('omitting inStock does not filter by stock', async () => {
      const account = await insertAccount(db);
      await insertProduct(db, { accountId: account.id, name: 'Shoe' });
      const service = await build();

      const result = await service.findAll(
        { limit: 20, offset: 0 },
        account.id,
      );

      expect(result.total).toBe(1);
    });
  });

  describe('sort', () => {
    async function makeThree(account: { id: number }) {
      const cheap = await insertProduct(db, {
        accountId: account.id,
        name: 'Banana',
      });
      await insertProductWithVariants(db, {
        accountId: account.id,
        productId: cheap.id,
        variants: [{ priceCents: 500 }],
      });
      const mid = await insertProduct(db, {
        accountId: account.id,
        name: 'Apple',
      });
      await insertProductWithVariants(db, {
        accountId: account.id,
        productId: mid.id,
        variants: [{ priceCents: 1500 }],
      });
      const expensive = await insertProduct(db, {
        accountId: account.id,
        name: 'Cherry',
      });
      await insertProductWithVariants(db, {
        accountId: account.id,
        productId: expensive.id,
        variants: [{ priceCents: 2500 }],
      });
      return { cheap, mid, expensive };
    }

    it('sorts by price ascending by default', async () => {
      const account = await insertAccount(db);
      await makeThree(account);
      const service = await build();

      const result = await service.findAll(
        { limit: 20, offset: 0, sortBy: 'price' },
        account.id,
      );

      expect(result.items.map((i) => i.name)).toEqual([
        'Banana',
        'Apple',
        'Cherry',
      ]);
    });

    it('sorts by price descending', async () => {
      const account = await insertAccount(db);
      await makeThree(account);
      const service = await build();

      const result = await service.findAll(
        { limit: 20, offset: 0, sortBy: 'price', sortDir: 'desc' },
        account.id,
      );

      expect(result.items.map((i) => i.name)).toEqual([
        'Cherry',
        'Apple',
        'Banana',
      ]);
    });

    it('sorts by name', async () => {
      const account = await insertAccount(db);
      await makeThree(account);
      const service = await build();

      const result = await service.findAll(
        { limit: 20, offset: 0, sortBy: 'name' },
        account.id,
      );

      expect(result.items.map((i) => i.name)).toEqual([
        'Apple',
        'Banana',
        'Cherry',
      ]);
    });

    it('sorts by newest descending (most recently created first)', async () => {
      const account = await insertAccount(db);
      await insertProduct(db, { accountId: account.id, name: 'First' });
      await insertProduct(db, { accountId: account.id, name: 'Second' });
      const service = await build();

      const result = await service.findAll(
        { limit: 20, offset: 0, sortBy: 'newest', sortDir: 'desc' },
        account.id,
      );

      expect(result.items.map((i) => i.name)).toEqual(['Second', 'First']);
    });

    it('sorts by newest ascending (oldest first)', async () => {
      const account = await insertAccount(db);
      await insertProduct(db, { accountId: account.id, name: 'First' });
      await insertProduct(db, { accountId: account.id, name: 'Second' });
      const service = await build();

      const result = await service.findAll(
        { limit: 20, offset: 0, sortBy: 'newest', sortDir: 'asc' },
        account.id,
      );

      expect(result.items.map((i) => i.name)).toEqual(['First', 'Second']);
    });

    it('with no sortBy, keeps the original id-ascending order', async () => {
      const account = await insertAccount(db);
      await makeThree(account);
      const service = await build();

      const result = await service.findAll(
        { limit: 20, offset: 0 },
        account.id,
      );

      expect(result.items.map((i) => i.name)).toEqual([
        'Banana',
        'Apple',
        'Cherry',
      ]);
    });
  });
});
