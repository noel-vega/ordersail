import { Test } from '@nestjs/testing';
import {
  insertAccount,
  insertCategory,
  insertProduct,
  useTestDb,
} from 'test-support';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { CategoriesService } from './categories.service';

const db = useTestDb();

async function build() {
  const ref = await Test.createTestingModule({
    providers: [CategoriesService, { provide: DRIZZLE, useValue: db }],
  }).compile();
  return ref.get(CategoriesService);
}

describe('CategoriesService.findAll (OS-162)', () => {
  it('paginates by name, filters by q, stays account-scoped', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    for (const name of ['Hats', 'Gloves', 'Scarves']) {
      await insertCategory(db, { accountId: a.id, name });
    }
    await insertCategory(db, { accountId: b.id, name: 'Hats' });
    const service = await build();

    const page = await service.findAll(2, 0, a.id);
    expect(page.items.map((c) => c.name)).toEqual(['Gloves', 'Hats']);
    expect(page.total).toBe(3);

    expect((await service.findAll(20, 0, a.id, 'scarv')).total).toBe(1);
    expect((await service.findAll(999, -1, a.id)).limit).toBe(100);
  });

  it('reports productCount per category (OS-187)', async () => {
    const account = await insertAccount(db);
    const used = await insertCategory(db, { accountId: account.id, name: 'Used' });
    const unused = await insertCategory(db, { accountId: account.id, name: 'Unused' });
    await insertProduct(db, { accountId: account.id, categoryIds: [used.id] });
    await insertProduct(db, { accountId: account.id, categoryIds: [used.id] });
    const service = await build();

    const page = await service.findAll(20, 0, account.id);
    const byName = new Map(page.items.map((c) => [c.name, c.productCount]));
    expect(byName.get('Used')).toBe(2);
    expect(byName.get('Unused')).toBe(0);
  });
});

describe('CategoriesService.update (OS-187)', () => {
  it('renames a category, scoped to its account', async () => {
    const account = await insertAccount(db);
    const other = await insertAccount(db);
    const category = await insertCategory(db, { accountId: account.id, name: 'Old' });
    const service = await build();

    const updated = await service.update(category.id, { name: 'New' }, account.id);
    expect(updated?.name).toBe('New');

    expect(
      await service.update(category.id, { name: 'Nope' }, other.id),
    ).toBeUndefined();
  });
});

describe('CategoriesService.remove (OS-187)', () => {
  it('deletes a category even when products still reference it (cascades the join)', async () => {
    const account = await insertAccount(db);
    const category = await insertCategory(db, { accountId: account.id });
    await insertProduct(db, { accountId: account.id, categoryIds: [category.id] });
    const service = await build();

    const removed = await service.remove(category.id, account.id);
    expect(removed?.id).toBe(category.id);
  });

  it('returns undefined for a category outside the account', async () => {
    const account = await insertAccount(db);
    const other = await insertAccount(db);
    const category = await insertCategory(db, { accountId: account.id });
    const service = await build();

    expect(await service.remove(category.id, other.id)).toBeUndefined();
  });
});
