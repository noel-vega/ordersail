import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  insertAccount,
  insertBrand,
  insertLocation,
  insertProduct,
  useTestDb,
} from 'test-support';
import { eq, inventoryTable } from 'db/stock';
import { productVariantsTable, productsTable } from 'db/catalog';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { StorageService } from 'src/shared/storage/storage.service';
import { ProductsService } from './products.service';

const db = useTestDb();

async function build() {
  const ref = await Test.createTestingModule({
    providers: [
      ProductsService,
      { provide: DRIZZLE, useValue: db },
      { provide: StorageService, useValue: {} },
    ],
  }).compile();
  return ref.get(ProductsService);
}

describe('ProductsService.findAll (OS-159)', () => {
  it('paginates and reports the account-wide total', async () => {
    const account = await insertAccount(db);
    for (let i = 0; i < 25; i++) {
      await insertProduct(db, { accountId: account.id });
    }
    const service = await build();

    const first = await service.findAll(10, 0, account.id);
    expect(first.items).toHaveLength(10);
    expect(first).toMatchObject({ total: 25, limit: 10, offset: 0 });

    const third = await service.findAll(10, 20, account.id);
    expect(third.items).toHaveLength(5);
  });

  it('clamps limit to 100 and floors a negative offset', async () => {
    const account = await insertAccount(db);
    await insertProduct(db, { accountId: account.id });
    const service = await build();

    const page = await service.findAll(999, -5, account.id);
    expect(page).toMatchObject({ limit: 100, offset: 0 });
  });

  it('filters by status', async () => {
    const account = await insertAccount(db);
    await insertProduct(db, { accountId: account.id, status: 'active' });
    await insertProduct(db, { accountId: account.id, status: 'active' });
    await insertProduct(db, { accountId: account.id, status: 'draft' });
    await insertProduct(db, { accountId: account.id, status: 'archived' });
    const service = await build();

    expect(
      (await service.findAll(20, 0, account.id, { status: 'active' })).total,
    ).toBe(2);
    expect(
      (await service.findAll(20, 0, account.id, { status: 'draft' })).total,
    ).toBe(1);
  });

  it('filters by q on name or description, case-insensitive', async () => {
    const account = await insertAccount(db);
    await insertProduct(db, {
      accountId: account.id,
      name: 'Merino Wool Beanie',
      description: 'warm',
    });
    await insertProduct(db, {
      accountId: account.id,
      name: 'Cotton Cap',
      description: 'a merino-blend lining',
    });
    await insertProduct(db, { accountId: account.id, name: 'Leather Belt' });
    const service = await build();

    expect(
      (await service.findAll(20, 0, account.id, { q: 'MERINO' })).total,
    ).toBe(2);
    expect(
      (await service.findAll(20, 0, account.id, { q: 'belt' })).total,
    ).toBe(1);
    expect(
      (await service.findAll(20, 0, account.id, { q: 'nothing' })).total,
    ).toBe(0);
  });

  it('is scoped to the account and carries a thumbnail field', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    await insertProduct(db, { accountId: a.id });
    await insertProduct(db, { accountId: b.id });
    const service = await build();

    const page = await service.findAll(20, 0, a.id);
    expect(page.total).toBe(1);
    expect(page.items[0]).toHaveProperty('thumbnailUrl', null);
  });
});

// signup seeds no location (OS-689), so the first products can be created
// before there's anywhere to hold stock
describe('ProductsService opening stock with no location (OS-689)', () => {
  async function setup() {
    const account = await insertAccount(db);
    const brand = await insertBrand(db, { accountId: account.id });
    const service = await build();
    const productBody = (stock: number) => ({
      name: 'Tee',
      description: 'A shirt',
      priceCents: 2000,
      brandId: brand.id,
      sku: 'TEE-1',
      stock,
      status: 'active' as const,
      categoryIds: [],
      barcodes: [],
    });
    return { account, service, productBody };
  }

  async function inventoryRowsFor(productId: number) {
    return db
      .select({ stock: inventoryTable.stock })
      .from(inventoryTable)
      .innerJoin(
        productVariantsTable,
        eq(productVariantsTable.id, inventoryTable.variantId),
      )
      .where(eq(productVariantsTable.productId, productId));
  }

  it('creates a product at stock 0 without an inventory row', async () => {
    const { account, service, productBody } = await setup();

    const product = await service.create(productBody(0), account.id);

    expect(await inventoryRowsFor(product.id)).toEqual([]);
  });

  it('refuses opening stock, and writes nothing, when there is no location', async () => {
    const { account, service, productBody } = await setup();

    await expect(service.create(productBody(5), account.id)).rejects.toThrow(
      new BadRequestException('Add a location before setting stock'),
    );
    const products = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.accountId, account.id));
    expect(products).toEqual([]);
  });

  it("puts opening stock at the account's first location once one exists", async () => {
    const { account, service, productBody } = await setup();
    await insertLocation(db, { accountId: account.id });

    const product = await service.create(productBody(5), account.id);

    expect(await inventoryRowsFor(product.id)).toEqual([{ stock: 5 }]);
  });

  // merchant-web's useStockLocation adjusts stock at the lowest id too; the
  // location list sorts by name, so "first" must not follow it
  it('picks the lowest-id location, not the first by name', async () => {
    const { account, service, productBody } = await setup();
    const older = await insertLocation(db, {
      accountId: account.id,
      name: 'Warehouse',
    });
    await insertLocation(db, { accountId: account.id, name: 'Annex' });

    const product = await service.create(productBody(5), account.id);

    const rows = await db
      .select({ locationId: inventoryTable.locationId })
      .from(inventoryTable)
      .innerJoin(
        productVariantsTable,
        eq(productVariantsTable.id, inventoryTable.variantId),
      )
      .where(eq(productVariantsTable.productId, product.id));
    expect(rows).toEqual([{ locationId: older.id }]);
  });

  it('adds variants at stock 0 with no location, and refuses stock', async () => {
    const { account, service, productBody } = await setup();
    const product = await service.create(productBody(0), account.id);
    const variants = (stock: number) => ({
      options: [{ name: 'Size', values: ['S', 'M'] }],
      priceCents: 2000,
      stock,
    });

    await expect(
      service.createVariants(product.id, variants(3), account.id),
    ).rejects.toThrow('Add a location before setting stock');

    const created = await service.createVariants(
      product.id,
      variants(0),
      account.id,
    );
    expect(created.length).toBeGreaterThanOrEqual(2);
    expect(await inventoryRowsFor(product.id)).toEqual([]);
  });
});
