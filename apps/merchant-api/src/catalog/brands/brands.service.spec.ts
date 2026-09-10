import { Test } from '@nestjs/testing';
import { insertAccount, insertBrand, useTestDb } from 'test-support';
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
