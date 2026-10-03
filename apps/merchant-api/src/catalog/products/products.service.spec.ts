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
import { LocationsService } from 'src/stock';
import { ProductsService } from './products.service';
import { LOCATIONS_PORT } from './ports/locations.port';
import { LocationsAdapter } from './ports/locations.adapter';

const db = useTestDb();

async function build() {
  const ref = await Test.createTestingModule({
    providers: [
      ProductsService,
      { provide: DRIZZLE, useValue: db },
      { provide: StorageService, useValue: {} },
      LocationsService,
      { provide: LOCATIONS_PORT, useClass: LocationsAdapter },
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

async function setup() {
  const account = await insertAccount(db);
  const brand = await insertBrand(db, { accountId: account.id });
  const service = await build();
  const productBody = (stock: number, locationId?: number) => ({
    name: 'Tee',
    description: 'A shirt',
    priceCents: 2000,
    brandId: brand.id,
    sku: 'TEE-1',
    stock,
    locationId,
    status: 'active' as const,
    categoryIds: [],
    barcodes: [],
  });
  const variantsBody = (stock: number, locationId?: number) => ({
    options: [{ name: 'Size', values: ['S', 'M'] }],
    priceCents: 2000,
    stock,
    locationId,
  });
  return { account, service, productBody, variantsBody };
}

async function inventoryRowsFor(productId: number) {
  return db
    .select({
      locationId: inventoryTable.locationId,
      stock: inventoryTable.stock,
    })
    .from(inventoryTable)
    .innerJoin(
      productVariantsTable,
      eq(productVariantsTable.id, inventoryTable.variantId),
    )
    .where(eq(productVariantsTable.productId, productId));
}

async function productCount(accountId: number) {
  const rows = await db
    .select({ id: productsTable.id })
    .from(productsTable)
    .where(eq(productsTable.accountId, accountId));
  return rows.length;
}

// signup seeds no location (OS-689), so the first products can be created
// before there's anywhere to hold stock
describe('ProductsService opening stock with no location (OS-689)', () => {
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
    expect(await productCount(account.id)).toBe(0);
  });

  it('adds variants at stock 0 with no location, and refuses stock', async () => {
    const { account, service, productBody, variantsBody } = await setup();
    const product = await service.create(productBody(0), account.id);

    await expect(
      service.createVariants(product.id, variantsBody(3), account.id),
    ).rejects.toThrow('Add a location before setting stock');

    const created = await service.createVariants(
      product.id,
      variantsBody(0),
      account.id,
    );
    expect(created.length).toBeGreaterThanOrEqual(2);
    expect(await inventoryRowsFor(product.id)).toEqual([]);
  });
});

// with a second location, where opening stock goes is the merchant's call —
// the API never guesses one (OS-696)
describe('ProductsService opening stock location (OS-696)', () => {
  // two of the account's own locations, plus one belonging to another account
  async function withLocations() {
    const ctx = await setup();
    const warehouse = await insertLocation(db, {
      accountId: ctx.account.id,
      name: 'Warehouse',
    });
    const annex = await insertLocation(db, {
      accountId: ctx.account.id,
      name: 'Annex',
    });
    const other = await insertAccount(db);
    const foreign = await insertLocation(db, { accountId: other.id });
    return { ...ctx, warehouse, annex, foreign };
  }

  describe('create', () => {
    it('puts opening stock at an explicit locationId, not the oldest', async () => {
      const { account, service, productBody, annex } = await withLocations();

      const product = await service.create(
        productBody(5, annex.id),
        account.id,
      );

      expect(await inventoryRowsFor(product.id)).toEqual([
        { locationId: annex.id, stock: 5 },
      ]);
    });

    it("refuses another account's locationId, and writes nothing", async () => {
      const { account, service, productBody, foreign } = await withLocations();

      await expect(
        service.create(productBody(5, foreign.id), account.id),
      ).rejects.toThrow(new BadRequestException('Location not found'));
      // checked even when there's no stock to place
      await expect(
        service.create(productBody(0, foreign.id), account.id),
      ).rejects.toThrow(new BadRequestException('Location not found'));
      expect(await productCount(account.id)).toBe(0);
    });

    it('uses the only location when locationId is omitted', async () => {
      const { account, service, productBody } = await setup();
      const only = await insertLocation(db, { accountId: account.id });

      const product = await service.create(productBody(5), account.id);

      expect(await inventoryRowsFor(product.id)).toEqual([
        { locationId: only.id, stock: 5 },
      ]);
    });

    it('refuses opening stock without a locationId once there are two locations', async () => {
      const { account, service, productBody } = await withLocations();

      await expect(service.create(productBody(5), account.id)).rejects.toThrow(
        new BadRequestException('Choose a location for the opening stock'),
      );
      expect(await productCount(account.id)).toBe(0);
    });

    it('creates at stock 0 without a locationId across two locations, writing no row', async () => {
      const { account, service, productBody } = await withLocations();

      const product = await service.create(productBody(0), account.id);

      expect(await inventoryRowsFor(product.id)).toEqual([]);
    });
  });

  // the product itself is created at stock 0, so every row seen below came
  // from createVariants — one per new variant (Size S, M)
  describe('createVariants', () => {
    it('puts opening stock at an explicit locationId, not the oldest', async () => {
      const { account, service, productBody, variantsBody, annex } =
        await withLocations();
      const product = await service.create(productBody(0), account.id);

      await service.createVariants(
        product.id,
        variantsBody(3, annex.id),
        account.id,
      );

      expect(await inventoryRowsFor(product.id)).toEqual([
        { locationId: annex.id, stock: 3 },
        { locationId: annex.id, stock: 3 },
      ]);
    });

    it("refuses another account's locationId, and writes nothing", async () => {
      const { account, service, productBody, variantsBody, foreign } =
        await withLocations();
      const product = await service.create(productBody(0), account.id);

      await expect(
        service.createVariants(
          product.id,
          variantsBody(3, foreign.id),
          account.id,
        ),
      ).rejects.toThrow(new BadRequestException('Location not found'));
      // checked even when there's no stock to place
      await expect(
        service.createVariants(
          product.id,
          variantsBody(0, foreign.id),
          account.id,
        ),
      ).rejects.toThrow(new BadRequestException('Location not found'));
      expect(await inventoryRowsFor(product.id)).toEqual([]);
    });

    it('uses the only location when locationId is omitted', async () => {
      const { account, service, productBody, variantsBody } = await setup();
      const only = await insertLocation(db, { accountId: account.id });
      const product = await service.create(productBody(0), account.id);

      await service.createVariants(product.id, variantsBody(3), account.id);

      expect(await inventoryRowsFor(product.id)).toEqual([
        { locationId: only.id, stock: 3 },
        { locationId: only.id, stock: 3 },
      ]);
    });

    it('refuses opening stock without a locationId once there are two locations', async () => {
      const { account, service, productBody, variantsBody } =
        await withLocations();
      const product = await service.create(productBody(0), account.id);

      await expect(
        service.createVariants(product.id, variantsBody(3), account.id),
      ).rejects.toThrow(
        new BadRequestException('Choose a location for the opening stock'),
      );
      expect(await inventoryRowsFor(product.id)).toEqual([]);
    });

    it('adds variants at stock 0 without a locationId across two locations, writing no row', async () => {
      const { account, service, productBody, variantsBody } =
        await withLocations();
      const product = await service.create(productBody(0), account.id);

      const created = await service.createVariants(
        product.id,
        variantsBody(0),
        account.id,
      );

      expect(created.length).toBeGreaterThanOrEqual(2);
      expect(await inventoryRowsFor(product.id)).toEqual([]);
    });
  });
});
