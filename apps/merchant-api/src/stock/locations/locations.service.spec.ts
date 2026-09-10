import { Test } from '@nestjs/testing';
import { insertAccount, insertLocation, useTestDb } from 'test-support';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { LocationsService } from './locations.service';

const db = useTestDb();

async function build() {
  const ref = await Test.createTestingModule({
    providers: [LocationsService, { provide: DRIZZLE, useValue: db }],
  }).compile();
  return ref.get(LocationsService);
}

describe('LocationsService.findAll (OS-162)', () => {
  it('paginates by name, filters by q, stays account-scoped', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    for (const name of ['Warehouse East', 'Retail Floor', 'Warehouse West']) {
      await insertLocation(db, { accountId: a.id, name });
    }
    await insertLocation(db, { accountId: b.id, name: 'Warehouse East' });
    const service = await build();

    const page = await service.findAll(2, 0, a.id);
    expect(page.items.map((l) => l.name)).toEqual([
      'Retail Floor',
      'Warehouse East',
    ]);
    expect(page.total).toBe(3);

    expect((await service.findAll(20, 0, a.id, 'warehouse')).total).toBe(2);
    expect((await service.findAll(999, -1, a.id)).limit).toBe(100);
  });
});
