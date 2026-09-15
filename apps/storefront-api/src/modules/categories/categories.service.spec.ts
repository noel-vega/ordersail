import { Test, TestingModule } from '@nestjs/testing';
import {
  insertAccount,
  insertCategory,
  insertProduct,
  useTestDb,
} from 'test-support';
import { CategoriesService } from './categories.service';
import { DRIZZLE } from '../../database/database.constants';

const db = useTestDb();

async function build() {
  const module: TestingModule = await Test.createTestingModule({
    providers: [CategoriesService, { provide: DRIZZLE, useValue: db }],
  }).compile();
  return module.get<CategoriesService>(CategoriesService);
}

describe('CategoriesService', () => {
  it('is defined', async () => {
    expect(await build()).toBeDefined();
  });

  it('returns an empty page when the account has no categories', async () => {
    const account = await insertAccount(db);
    const service = await build();

    const result = await service.findAll({ limit: 20, offset: 0 }, account.id);

    expect(result).toEqual({ items: [], total: 0, limit: 20, offset: 0 });
  });

  it('counts only active products, ordered by name', async () => {
    const account = await insertAccount(db);
    const shoes = await insertCategory(db, {
      accountId: account.id,
      name: 'Shoes',
    });
    const hats = await insertCategory(db, {
      accountId: account.id,
      name: 'Hats',
    });
    await insertProduct(db, {
      accountId: account.id,
      name: 'Sneaker',
      status: 'active',
      categoryIds: [shoes.id],
    });
    await insertProduct(db, {
      accountId: account.id,
      name: 'Draft boot',
      status: 'draft',
      categoryIds: [shoes.id],
    });
    const service = await build();

    const result = await service.findAll({ limit: 20, offset: 0 }, account.id);

    expect(result.items).toEqual([
      { id: hats.id, name: 'Hats', productCount: 0 },
      { id: shoes.id, name: 'Shoes', productCount: 1 },
    ]);
  });

  it('excludes another account', async () => {
    const mine = await insertAccount(db);
    const theirs = await insertAccount(db);
    await insertCategory(db, { accountId: mine.id, name: 'Mine' });
    await insertCategory(db, { accountId: theirs.id, name: 'Not mine' });
    const service = await build();

    const result = await service.findAll({ limit: 20, offset: 0 }, mine.id);

    expect(result.total).toBe(1);
    expect(result.items.map((i) => i.name)).toEqual(['Mine']);
  });

  it('findOne returns undefined for an unknown id or the wrong account', async () => {
    const account = await insertAccount(db);
    const other = await insertAccount(db);
    const category = await insertCategory(db, {
      accountId: other.id,
      name: 'Theirs',
    });
    const service = await build();

    expect(await service.findOne(999, account.id)).toBeUndefined();
    expect(await service.findOne(category.id, account.id)).toBeUndefined();
  });

  it('findOne returns the category for the right account', async () => {
    const account = await insertAccount(db);
    const category = await insertCategory(db, {
      accountId: account.id,
      name: 'Shoes',
    });
    const service = await build();

    expect(await service.findOne(category.id, account.id)).toEqual({
      id: category.id,
      name: 'Shoes',
    });
  });
});
