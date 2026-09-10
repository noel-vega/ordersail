import { Test } from '@nestjs/testing';
import { insertAccount, insertCategory, useTestDb } from 'test-support';
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
});
