import { Test, TestingModule } from '@nestjs/testing';
import {
  insertAccount,
  insertBrand,
  insertProduct,
  useTestDb,
} from 'test-support';
import { BrandsService } from './brands.service';
import { DRIZZLE } from '../../database/database.constants';

const db = useTestDb();

async function build() {
  const module: TestingModule = await Test.createTestingModule({
    providers: [BrandsService, { provide: DRIZZLE, useValue: db }],
  }).compile();
  return module.get<BrandsService>(BrandsService);
}

describe('BrandsService', () => {
  it('is defined', async () => {
    expect(await build()).toBeDefined();
  });

  it('returns an empty page when the account has no brands', async () => {
    const account = await insertAccount(db);
    const service = await build();

    const result = await service.findAll({ limit: 20, offset: 0 }, account.id);

    expect(result).toEqual({ items: [], total: 0, limit: 20, offset: 0 });
  });

  it('counts only active products, ordered by name', async () => {
    const account = await insertAccount(db);
    const acme = await insertBrand(db, { accountId: account.id, name: 'Acme' });
    const zeta = await insertBrand(db, { accountId: account.id, name: 'Zeta' });
    await insertProduct(db, {
      accountId: account.id,
      name: 'Sneaker',
      status: 'active',
      brandId: acme.id,
    });
    await insertProduct(db, {
      accountId: account.id,
      name: 'Draft boot',
      status: 'draft',
      brandId: acme.id,
    });
    const service = await build();

    const result = await service.findAll({ limit: 20, offset: 0 }, account.id);

    expect(result.items).toEqual([
      { id: acme.id, name: 'Acme', productCount: 1 },
      { id: zeta.id, name: 'Zeta', productCount: 0 },
    ]);
  });

  it('excludes another account', async () => {
    const mine = await insertAccount(db);
    const theirs = await insertAccount(db);
    await insertBrand(db, { accountId: mine.id, name: 'Mine' });
    await insertBrand(db, { accountId: theirs.id, name: 'Not mine' });
    const service = await build();

    const result = await service.findAll({ limit: 20, offset: 0 }, mine.id);

    expect(result.total).toBe(1);
    expect(result.items.map((i) => i.name)).toEqual(['Mine']);
  });

  it('findOne returns undefined for an unknown id or the wrong account', async () => {
    const account = await insertAccount(db);
    const other = await insertAccount(db);
    const brand = await insertBrand(db, {
      accountId: other.id,
      name: 'Theirs',
    });
    const service = await build();

    expect(await service.findOne(999, account.id)).toBeUndefined();
    expect(await service.findOne(brand.id, account.id)).toBeUndefined();
  });

  it('findOne returns the brand for the right account', async () => {
    const account = await insertAccount(db);
    const brand = await insertBrand(db, {
      accountId: account.id,
      name: 'Acme',
    });
    const service = await build();

    expect(await service.findOne(brand.id, account.id)).toEqual({
      id: brand.id,
      name: 'Acme',
    });
  });
});
