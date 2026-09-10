import { Test } from '@nestjs/testing';
import { insertAccount, insertCustomer, useTestDb } from 'test-support';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { CustomersService } from './customers.service';

const db = useTestDb();

async function build() {
  const ref = await Test.createTestingModule({
    providers: [CustomersService, { provide: DRIZZLE, useValue: db }],
  }).compile();
  return ref.get(CustomersService);
}

describe('CustomersService.findAll (OS-158)', () => {
  it('paginates and reports the account-wide total', async () => {
    const account = await insertAccount(db);
    for (let i = 0; i < 25; i++) {
      await insertCustomer(db, { accountId: account.id });
    }
    const service = await build();

    const first = await service.findAll(10, 0, account.id);
    expect(first.items).toHaveLength(10);
    expect(first).toMatchObject({ total: 25, limit: 10, offset: 0 });

    const third = await service.findAll(10, 20, account.id);
    expect(third.items).toHaveLength(5);
    expect(third.total).toBe(25);
  });

  it('clamps limit to 100 and floors a negative offset', async () => {
    const account = await insertAccount(db);
    await insertCustomer(db, { accountId: account.id });
    const service = await build();

    const page = await service.findAll(999, -5, account.id);
    expect(page).toMatchObject({ limit: 100, offset: 0 });
  });

  it('filters by q on first name, last name or email, case-insensitive', async () => {
    const account = await insertAccount(db);
    await insertCustomer(db, {
      accountId: account.id,
      firstname: 'Dana',
      lastname: 'Scully',
      email: 'dana@fbi.test',
    });
    await insertCustomer(db, {
      accountId: account.id,
      firstname: 'Fox',
      lastname: 'Mulder',
      email: 'fox@fbi.test',
    });
    const service = await build();

    expect(
      (await service.findAll(20, 0, account.id, 'scul')).items,
    ).toHaveLength(1);
    expect(
      (await service.findAll(20, 0, account.id, 'FOX')).items,
    ).toHaveLength(1);
    expect(
      (await service.findAll(20, 0, account.id, 'fbi.test')).items,
    ).toHaveLength(2);
    expect(
      (await service.findAll(20, 0, account.id, 'nobody')).items,
    ).toHaveLength(0);
  });

  it('is scoped to the account', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    await insertCustomer(db, { accountId: a.id });
    await insertCustomer(db, { accountId: b.id });
    const service = await build();

    const page = await service.findAll(20, 0, a.id);
    expect(page.total).toBe(1);
    expect(page.items[0]?.accountId).toBe(a.id);
  });
});
