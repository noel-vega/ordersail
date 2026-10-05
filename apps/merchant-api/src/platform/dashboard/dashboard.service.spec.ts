import { Test } from '@nestjs/testing';
import { accountsTable, eq } from 'db';
import {
  insertAccount,
  insertLocation,
  insertProduct,
  insertProductWithVariants,
  useTestDb,
} from 'test-support';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { DashboardService } from './dashboard.service';
import { VariantStockService } from 'src/stock';
import { SALES_PORT } from './ports/sales.port';
import { STOCK_PORT } from './ports/stock.port';
import { StockAdapter } from './ports/stock.adapter';

const db = useTestDb();

async function build() {
  const ref = await Test.createTestingModule({
    providers: [
      DashboardService,
      VariantStockService,
      { provide: DRIZZLE, useValue: db },
      { provide: STOCK_PORT, useClass: StockAdapter },
      {
        provide: SALES_PORT,
        useValue: {
          recentOrders: () => Promise.resolve([]),
          recentCustomers: () => Promise.resolve([]),
        },
      },
    ],
  }).compile();
  return ref.get(DashboardService);
}

describe('DashboardService.getSummary — fresh account (OS-173)', () => {
  it('returns zeroes and empty lists with no orders or products', async () => {
    const account = await insertAccount(db);
    const service = await build();

    await expect(service.getSummary(account.id)).resolves.toEqual({
      outOfStockCount: 0,
      lowStockCount: 0,
      lowStockThreshold: 5,
      recentOrders: [],
      recentCustomers: [],
    });
  });

  it('counts an unstocked variant as out of stock without throwing', async () => {
    const account = await insertAccount(db);
    await insertLocation(db, { accountId: account.id, withAddress: false });
    await insertProductWithVariants(db, {
      accountId: account.id,
      variants: [{ priceCents: 1000 }], // no stock rows
    });
    const service = await build();

    const summary = await service.getSummary(account.id);
    expect(summary.outOfStockCount).toBe(1);
  });
});

describe('DashboardService stock alerts (OS-195)', () => {
  // an account with a low-stock threshold and two locations
  async function setup(lowStockThreshold = 5) {
    const account = await insertAccount(db, { lowStockThreshold });
    const [a, b] = await Promise.all([
      insertLocation(db, { accountId: account.id, withAddress: false }),
      insertLocation(db, { accountId: account.id, withAddress: false }),
    ]);
    return { account, a: a.id, b: b.id };
  }

  it('stock == threshold is low; 0 or negative is out, not low', async () => {
    const { account, a } = await setup(5);
    await insertProductWithVariants(db, {
      accountId: account.id,
      variants: [
        { stock: [{ locationId: a, stock: 5 }] }, // low (== threshold)
        { stock: [{ locationId: a, stock: 1 }] }, // low
        { stock: [{ locationId: a, stock: 6 }] }, // fine
        { stock: [{ locationId: a, stock: 0 }] }, // out
        { stock: [{ locationId: a, stock: -2 }] }, // out (oversold)
        {}, // out: no inventory rows at all
      ],
    });
    const service = await build();

    await expect(service.getSummary(account.id)).resolves.toMatchObject({
      outOfStockCount: 3,
      lowStockCount: 2,
      lowStockThreshold: 5,
    });
  });

  it('sums stock across locations', async () => {
    const { account, a, b } = await setup(5);
    await insertProductWithVariants(db, {
      accountId: account.id,
      variants: [
        // 4 + 4 = 8 → fine, though each location alone would be low
        {
          stock: [
            { locationId: a, stock: 4 },
            { locationId: b, stock: 4 },
          ],
        },
        // 0 + 3 = 3 → low, not out
        {
          stock: [
            { locationId: a, stock: 0 },
            { locationId: b, stock: 3 },
          ],
        },
      ],
    });
    const service = await build();

    await expect(service.getSummary(account.id)).resolves.toMatchObject({
      outOfStockCount: 0,
      lowStockCount: 1,
    });
  });

  it('leaves out archived products but counts drafts', async () => {
    const { account, a } = await setup(5);
    const archived = await insertProduct(db, {
      accountId: account.id,
      status: 'archived',
    });
    const draft = await insertProduct(db, {
      accountId: account.id,
      status: 'draft',
    });
    await insertProductWithVariants(db, {
      accountId: account.id,
      productId: archived.id,
      variants: [{ stock: [{ locationId: a, stock: 0 }] }],
    });
    await insertProductWithVariants(db, {
      accountId: account.id,
      productId: draft.id,
      variants: [{ stock: [{ locationId: a, stock: 2 }] }],
    });
    const service = await build();

    await expect(service.getSummary(account.id)).resolves.toMatchObject({
      outOfStockCount: 0,
      lowStockCount: 1,
    });
    const { items } = await service.getLowStock(account.id, 10);
    expect(items.map((i) => i.productId)).toEqual([draft.id]);
  });

  it('is scoped to the account', async () => {
    const { account } = await setup();
    const other = await setup();
    await insertProductWithVariants(db, {
      accountId: other.account.id,
      variants: [{ stock: [{ locationId: other.a, stock: 1 }] }, {}],
    });
    const service = await build();

    await expect(service.getSummary(account.id)).resolves.toMatchObject({
      outOfStockCount: 0,
      lowStockCount: 0,
    });
    await expect(service.getLowStock(account.id, 10)).resolves.toEqual({
      items: [],
      lowStockThreshold: 5,
    });
  });

  it('lists low and out variants, lowest stock first, then product name', async () => {
    const { account, a, b } = await setup(5);
    const [shirtLarge, shirtSmall] = await insertProductWithVariants(db, {
      accountId: account.id,
      productName: 'Shirt',
      variants: [
        {
          sku: 'SH-L',
          option: { name: 'Size', value: 'Large' },
          stock: [
            { locationId: a, stock: 1 },
            { locationId: b, stock: 2 },
          ],
        },
        {
          sku: 'SH-S',
          option: { name: 'Size', value: 'Small' },
          stock: [{ locationId: a, stock: 9 }], // fine — not listed
        },
      ],
    });
    const [apron] = await insertProductWithVariants(db, {
      accountId: account.id,
      productName: 'Apron',
      variants: [{ stock: [{ locationId: a, stock: 3 }] }],
    });
    const [mug] = await insertProductWithVariants(db, {
      accountId: account.id,
      productName: 'Mug',
      variants: [{ sku: 'MUG', stock: [{ locationId: a, stock: 0 }] }],
    });
    const service = await build();

    const { items } = await service.getLowStock(account.id, 10);
    expect(items).toEqual([
      {
        variantId: mug.id,
        productId: mug.productId,
        productName: 'Mug',
        sku: 'MUG',
        optionsLabel: null,
        stock: 0,
      },
      // both at 3: Apron before Shirt by name
      {
        variantId: apron.id,
        productId: apron.productId,
        productName: 'Apron',
        sku: null,
        optionsLabel: null,
        stock: 3,
      },
      {
        variantId: shirtLarge.id,
        productId: shirtLarge.productId,
        productName: 'Shirt',
        sku: 'SH-L',
        optionsLabel: 'Large',
        stock: 3,
      },
    ]);
    expect(items.map((i) => i.variantId)).not.toContain(shirtSmall.id);

    // limit is clamped to 1..50
    await expect(service.getLowStock(account.id, 1)).resolves.toMatchObject({
      items: [{ variantId: mug.id }],
    });
    expect((await service.getLowStock(account.id, 0)).items).toHaveLength(1);
    expect((await service.getLowStock(account.id, 999)).items).toHaveLength(3);
  });

  it('joins multiple options in option order', async () => {
    const { account, a } = await setup(5);
    const [variant] = await insertProductWithVariants(db, {
      accountId: account.id,
      variants: [
        {
          options: [
            { name: 'Color', value: 'Blue' },
            { name: 'Size', value: 'Large' },
          ],
          stock: [{ locationId: a, stock: 1 }],
        },
      ],
    });
    const service = await build();

    const { items } = await service.getLowStock(account.id, 10);
    expect(items).toMatchObject([
      { variantId: variant.id, optionsLabel: 'Blue / Large' },
    ]);
  });

  it('follows a threshold change', async () => {
    const { account, a } = await setup(5);
    await insertProductWithVariants(db, {
      accountId: account.id,
      variants: [
        { stock: [{ locationId: a, stock: 3 }] },
        { stock: [{ locationId: a, stock: 8 }] },
      ],
    });
    const service = await build();
    expect((await service.getSummary(account.id)).lowStockCount).toBe(1);

    await db
      .update(accountsTable)
      .set({ lowStockThreshold: 10 })
      .where(eq(accountsTable.id, account.id));

    await expect(service.getSummary(account.id)).resolves.toMatchObject({
      lowStockCount: 2,
      lowStockThreshold: 10,
    });
    await expect(service.getLowStock(account.id, 10)).resolves.toMatchObject({
      items: [{ stock: 3 }, { stock: 8 }],
      lowStockThreshold: 10,
    });
  });
});
