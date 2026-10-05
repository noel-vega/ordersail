import { Test } from '@nestjs/testing';
import {
  insertAccount,
  insertLocation,
  insertProduct,
  insertProductWithVariants,
  useTestDb,
} from 'test-support';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { VariantStockService } from './variant-stock.service';

const db = useTestDb();

async function build() {
  const ref = await Test.createTestingModule({
    providers: [VariantStockService, { provide: DRIZZLE, useValue: db }],
  }).compile();
  return ref.get(VariantStockService);
}

// an account with a low-stock threshold and two locations, B named first
async function setup(lowStockThreshold = 5) {
  const account = await insertAccount(db, { lowStockThreshold });
  const a = await insertLocation(db, {
    accountId: account.id,
    name: 'Warehouse',
    withAddress: false,
  });
  const b = await insertLocation(db, {
    accountId: account.id,
    name: 'Storefront',
    withAddress: false,
  });
  return { account, a: a.id, b: b.id };
}

describe('VariantStockService.findAll (OS-693)', () => {
  it('sums stock across locations: 4 + 4 at threshold 5 is not low, 0 + 3 is', async () => {
    const { account, a, b } = await setup(5);
    const [fine, low] = await insertProductWithVariants(db, {
      accountId: account.id,
      variants: [
        {
          stock: [
            { locationId: a, stock: 4 },
            { locationId: b, stock: 4 },
          ],
        },
        {
          stock: [
            { locationId: a, stock: 0 },
            { locationId: b, stock: 3 },
          ],
        },
      ],
    });
    const service = await build();

    const page = await service.findAll(20, 0, account.id, { lowStock: true });
    expect(page).toMatchObject({ total: 1, lowStockThreshold: 5 });
    expect(page.items).toEqual([
      expect.objectContaining({ variantId: low.id, stock: 3 }),
    ]);
    expect(page.items.map((i) => i.variantId)).not.toContain(fine.id);

    // and 0 + 3 is low, not out
    await expect(service.counts(account.id)).resolves.toEqual({
      outOfStockCount: 0,
      lowStockCount: 1,
      lowStockThreshold: 5,
    });
  });

  it('lists exactly the variants counted as low or out', async () => {
    const { account, a, b } = await setup(5);
    const archived = await insertProduct(db, {
      accountId: account.id,
      status: 'archived',
    });
    await insertProductWithVariants(db, {
      accountId: account.id,
      productId: archived.id,
      variants: [{ stock: [{ locationId: a, stock: 0 }] }], // off sale
    });
    const listed = await insertProductWithVariants(db, {
      accountId: account.id,
      variants: [
        { stock: [{ locationId: a, stock: 5 }] }, // low (== threshold)
        { stock: [{ locationId: a, stock: 0 }] }, // out
        { stock: [{ locationId: b, stock: -2 }] }, // out (oversold)
        {}, // out: no inventory rows
      ],
    });
    await insertProductWithVariants(db, {
      accountId: account.id,
      variants: [{ stock: [{ locationId: a, stock: 6 }] }], // fine
    });
    const other = await setup(5);
    await insertProductWithVariants(db, {
      accountId: other.account.id,
      variants: [{ stock: [{ locationId: other.a, stock: 1 }] }],
    });
    const service = await build();

    const page = await service.findAll(100, 0, account.id, { lowStock: true });
    const counts = await service.counts(account.id);
    expect(page.total).toBe(counts.outOfStockCount + counts.lowStockCount);
    expect(counts).toMatchObject({ outOfStockCount: 3, lowStockCount: 1 });
    expect(page.items.map((i) => i.variantId).sort()).toEqual(
      listed.map((v) => v.id).sort(),
    );
  });

  it('with lowStock, orders most urgent first; otherwise by product name', async () => {
    const { account, a } = await setup(5);
    const [apron] = await insertProductWithVariants(db, {
      accountId: account.id,
      productName: 'Apron',
      variants: [{ stock: [{ locationId: a, stock: 3 }] }],
    });
    const [mug] = await insertProductWithVariants(db, {
      accountId: account.id,
      productName: 'Mug',
      variants: [{ stock: [{ locationId: a, stock: 0 }] }],
    });
    const [zine] = await insertProductWithVariants(db, {
      accountId: account.id,
      productName: 'Zine',
      variants: [{ stock: [{ locationId: a, stock: 20 }] }],
    });
    const service = await build();

    const low = await service.findAll(20, 0, account.id, { lowStock: true });
    expect(low.items.map((i) => i.variantId)).toEqual([mug.id, apron.id]);

    const all = await service.findAll(20, 0, account.id);
    expect(all.items.map((i) => i.variantId)).toEqual([
      apron.id,
      mug.id,
      zine.id,
    ]);
    expect(all.total).toBe(3);
  });

  it('returns one row per variant with its per-location breakdown', async () => {
    const { account, a, b } = await setup(5);
    const [stocked, unstocked] = await insertProductWithVariants(db, {
      accountId: account.id,
      productName: 'Shirt',
      variants: [
        {
          sku: 'SH-L',
          option: { name: 'Size', value: 'Large' },
          stock: [
            { locationId: a, stock: 7 },
            { locationId: b, stock: 2 },
          ],
        },
        { sku: 'SH-S', option: { name: 'Size', value: 'Small' } },
      ],
    });
    const service = await build();

    const { items } = await service.findAll(20, 0, account.id);
    expect(items).toEqual([
      {
        variantId: stocked.id,
        productId: stocked.productId,
        productName: 'Shirt',
        sku: 'SH-L',
        optionsLabel: 'Large',
        stock: 9,
        // by location name
        locations: [
          { locationId: b, locationName: 'Storefront', stock: 2 },
          { locationId: a, locationName: 'Warehouse', stock: 7 },
        ],
      },
      {
        variantId: unstocked.id,
        productId: unstocked.productId,
        productName: 'Shirt',
        sku: 'SH-S',
        optionsLabel: 'Small',
        stock: 0,
        locations: [],
      },
    ]);
  });

  it('filters by q (SKU or product name) and productId, and paginates', async () => {
    const { account, a } = await setup(5);
    const [beanie] = await insertProductWithVariants(db, {
      accountId: account.id,
      productName: 'Merino Beanie',
      variants: [{ sku: 'BEANIE-1', stock: [{ locationId: a, stock: 3 }] }],
    });
    const [cap, cap2] = await insertProductWithVariants(db, {
      accountId: account.id,
      productName: 'Cap',
      variants: [{ sku: 'CAP-1' }, { sku: 'CAP-2' }],
    });
    const service = await build();

    const bySku = await service.findAll(20, 0, account.id, { q: 'beanie-' });
    expect(bySku.items.map((i) => i.variantId)).toEqual([beanie.id]);

    const byProduct = await service.findAll(20, 0, account.id, {
      productId: cap.productId,
    });
    expect(byProduct.total).toBe(2);

    const page2 = await service.findAll(1, 1, account.id, {
      productId: cap.productId,
    });
    expect(page2).toMatchObject({ total: 2, limit: 1, offset: 1 });
    expect(page2.items.map((i) => i.variantId)).toEqual([cap2.id]);
  });
});
