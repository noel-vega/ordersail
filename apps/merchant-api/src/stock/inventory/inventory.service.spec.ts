import { Test } from '@nestjs/testing';
import { accountsTable, eq } from 'db/identity';
import {
  insertAccount,
  insertLocation,
  insertProductWithVariants,
  useTestDb,
} from 'test-support';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { InventoryService } from './inventory.service';
import { LocationsService } from '../locations/locations.service';

const db = useTestDb();

async function build() {
  const ref = await Test.createTestingModule({
    providers: [
      InventoryService,
      LocationsService,
      { provide: DRIZZLE, useValue: db },
    ],
  }).compile();
  return ref.get(InventoryService);
}

async function seed() {
  const account = await insertAccount(db);
  const locA = await insertLocation(db, { accountId: account.id, name: 'A' });
  const locB = await insertLocation(db, { accountId: account.id, name: 'B' });
  const [wool, cap] = await insertProductWithVariants(db, {
    accountId: account.id,
    productName: 'Merino Beanie',
    variants: [
      { sku: 'BEANIE-1', stock: [{ locationId: locA.id, stock: 3 }] },
      { sku: 'CAP-1', stock: [{ locationId: locB.id, stock: 50 }] },
    ],
  });
  return { account, locA, locB, wool, cap };
}

describe('InventoryService.findAll (OS-161)', () => {
  it('paginates, orders by product name, reports the total', async () => {
    const account = await insertAccount(db);
    const loc = await insertLocation(db, { accountId: account.id });
    for (let i = 0; i < 25; i++) {
      await insertProductWithVariants(db, {
        accountId: account.id,
        productName: `P${String(i).padStart(2, '0')}`,
        variants: [{ stock: [{ locationId: loc.id, stock: 1 }] }],
      });
    }
    const service = await build();

    const first = await service.findAll(10, 0, account.id);
    expect(first.items).toHaveLength(10);
    expect(first).toMatchObject({ total: 25, limit: 10, offset: 0 });
    expect(first.items[0]?.productName).toBe('P00');

    const page3 = await service.findAll(10, 20, account.id);
    expect(page3.items).toHaveLength(5);
  });

  it('filters by locationId, stockLte and q', async () => {
    const { account, locA } = await seed();
    const service = await build();

    expect((await service.findAll(20, 0, account.id)).total).toBe(2);
    expect(
      (await service.findAll(20, 0, account.id, { locationId: locA.id })).total,
    ).toBe(1);
    expect(
      (await service.findAll(20, 0, account.id, { stockLte: 5 })).items.map(
        (r) => r.sku,
      ),
    ).toEqual(['BEANIE-1']);
    expect(
      (await service.findAll(20, 0, account.id, { q: 'cap' })).items.map(
        (r) => r.sku,
      ),
    ).toEqual(['CAP-1']);
  });

  // seed(): BEANIE-1 at 3, CAP-1 at 50; the account threshold defaults to 5
  it("lowStock filters at or below the account's threshold (OS-668)", async () => {
    const { account } = await seed();
    const service = await build();
    const lowSkus = async () =>
      (await service.findAll(20, 0, account.id, { lowStock: true })).items.map(
        (r) => r.sku,
      );

    expect(await lowSkus()).toEqual(['BEANIE-1']);

    await db
      .update(accountsTable)
      .set({ lowStockThreshold: 50 })
      .where(eq(accountsTable.id, account.id));
    expect(await lowSkus()).toEqual(['BEANIE-1', 'CAP-1']);

    await db
      .update(accountsTable)
      .set({ lowStockThreshold: 2 })
      .where(eq(accountsTable.id, account.id));
    expect(await lowSkus()).toEqual([]);
  });

  it("lowStock uses the caller's account threshold, not another's", async () => {
    const { account } = await seed();
    await insertAccount(db, { lowStockThreshold: 100 });
    const service = await build();

    const page = await service.findAll(20, 0, account.id, { lowStock: true });
    expect(page.total).toBe(1);
    expect(page.lowStockThreshold).toBe(5);
  });

  // the client badges rows with this, so it must be the threshold the
  // filter used — even for staff who can't read GET /account
  it('returns the threshold with every page, filtered or not', async () => {
    const { account } = await seed();
    await db
      .update(accountsTable)
      .set({ lowStockThreshold: 12 })
      .where(eq(accountsTable.id, account.id));
    const service = await build();

    expect((await service.findAll(20, 0, account.id)).lowStockThreshold).toBe(
      12,
    );
    expect(
      (await service.findAll(20, 0, account.id, { lowStock: true }))
        .lowStockThreshold,
    ).toBe(12);
  });

  it('is scoped to the account', async () => {
    const { account } = await seed();
    const other = await insertAccount(db);
    const loc = await insertLocation(db, { accountId: other.id });
    await insertProductWithVariants(db, {
      accountId: other.id,
      variants: [{ stock: [{ locationId: loc.id, stock: 9 }] }],
    });
    const service = await build();

    expect((await service.findAll(20, 0, account.id)).total).toBe(2);
  });
});

describe('InventoryService.findMovements (OS-161)', () => {
  it('paginates newest-first and filters by variantId / reason', async () => {
    const { account, locA, wool, cap } = await seed();
    const service = await build();

    await service.createMovement(
      { variantId: wool.id, locationId: locA.id, delta: 5, reason: 'received' },
      undefined,
      account.id,
    );
    await service.createMovement(
      { variantId: wool.id, locationId: locA.id, delta: -1, reason: 'damaged' },
      undefined,
      account.id,
    );
    await service.createMovement(
      { variantId: cap.id, locationId: locA.id, delta: 2, reason: 'received' },
      undefined,
      account.id,
    );

    const all = await service.findMovements(20, 0, account.id);
    expect(all.total).toBe(3);
    expect(all.items[0]?.reason).toBe('received');
    expect(all.items[0]?.delta).toBe(2); // newest

    expect(
      (await service.findMovements(20, 0, account.id, { variantId: wool.id }))
        .total,
    ).toBe(2);
    expect(
      (await service.findMovements(20, 0, account.id, { reason: 'received' }))
        .total,
    ).toBe(2);

    const page = await service.findMovements(2, 0, account.id);
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
  });
});
