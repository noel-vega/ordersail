import { Test, TestingModule } from '@nestjs/testing';
import {
  insertAccount,
  insertBrand,
  insertCategory,
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
    it('matches on name or description, case-insensitively', async () => {
      const account = await insertAccount(db);
      await insertProduct(db, {
        accountId: account.id,
        name: 'Trail Runner',
        description: 'Lightweight shoe',
      });
      await insertProduct(db, {
        accountId: account.id,
        name: 'Umbrella',
        description: 'Keeps you dry on the trail',
      });
      await insertProduct(db, { accountId: account.id, name: 'Backpack' });
      const service = await build();

      const byName = await service.findAll(
        { limit: 20, offset: 0, q: 'trail' },
        account.id,
      );
      expect(byName.items.map((i) => i.name).sort()).toEqual([
        'Trail Runner',
        'Umbrella',
      ]);
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
});
