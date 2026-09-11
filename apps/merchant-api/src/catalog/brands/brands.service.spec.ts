import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  insertAccount,
  insertBrand,
  insertProduct,
  useTestDb,
} from 'test-support';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { BrandsService } from './brands.service';

const db = useTestDb();

async function build() {
  const ref = await Test.createTestingModule({
    providers: [BrandsService, { provide: DRIZZLE, useValue: db }],
  }).compile();
  return ref.get(BrandsService);
}

describe('BrandsService.findAll (OS-162)', () => {
  it('paginates, orders by name, reports the total', async () => {
    const account = await insertAccount(db);
    for (const name of ['Zed', 'Ada', 'Milo', 'Bea']) {
      await insertBrand(db, { accountId: account.id, name });
    }
    const service = await build();

    const first = await service.findAll(2, 0, account.id);
    expect(first.items.map((b) => b.name)).toEqual(['Ada', 'Bea']);
    expect(first).toMatchObject({ total: 4, limit: 2, offset: 0 });
  });

  it('clamps limit, filters by q, and stays account-scoped', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    await insertBrand(db, { accountId: a.id, name: 'Merino Co' });
    await insertBrand(db, { accountId: a.id, name: 'Cotton Inc' });
    await insertBrand(db, { accountId: b.id, name: 'Merino Rivals' });
    const service = await build();

    expect(await service.findAll(999, -1, a.id)).toMatchObject({
      limit: 100,
      offset: 0,
      total: 2,
    });
    expect((await service.findAll(20, 0, a.id, 'merino')).total).toBe(1);
  });
});

describe('BrandsService.update (OS-186)', () => {
  it('renames a brand, scoped to its account', async () => {
    const account = await insertAccount(db);
    const other = await insertAccount(db);
    const brand = await insertBrand(db, { accountId: account.id, name: 'Old' });
    const service = await build();

    const updated = await service.update(brand.id, { name: 'New' }, account.id);
    expect(updated?.name).toBe('New');

    expect(await service.update(brand.id, { name: 'Nope' }, other.id)).toBeUndefined();
  });
});

describe('BrandsService.remove (OS-186)', () => {
  it('deletes a brand with no products', async () => {
    const account = await insertAccount(db);
    const brand = await insertBrand(db, { accountId: account.id });
    const service = await build();

    const removed = await service.remove(brand.id, account.id);
    expect(removed?.id).toBe(brand.id);
  });

  it('blocks deleting a brand still assigned to a product', async () => {
    const account = await insertAccount(db);
    const brand = await insertBrand(db, { accountId: account.id });
    await insertProduct(db, { accountId: account.id, brandId: brand.id });
    const service = await build();

    await expect(service.remove(brand.id, account.id)).rejects.toThrow(
      ConflictException,
    );
  });

  it('returns undefined for a brand outside the account', async () => {
    const account = await insertAccount(db);
    const other = await insertAccount(db);
    const brand = await insertBrand(db, { accountId: account.id });
    const service = await build();

    expect(await service.remove(brand.id, other.id)).toBeUndefined();
  });
});
