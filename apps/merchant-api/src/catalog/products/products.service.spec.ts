import { Test } from '@nestjs/testing';
import { insertAccount, insertProduct, useTestDb } from 'test-support';
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
