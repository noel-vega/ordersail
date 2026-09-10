import { Test } from '@nestjs/testing';
import { insertAccount, insertUser, useTestDb } from 'test-support';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { EmailService } from 'src/shared/email/email.service';
import { PermissionsService } from '../permissions/permissions.service';
import { UsersService } from './users.service';

const db = useTestDb();

async function build() {
  const ref = await Test.createTestingModule({
    providers: [
      UsersService,
      { provide: DRIZZLE, useValue: db },
      { provide: EmailService, useValue: {} },
      { provide: PermissionsService, useValue: {} },
    ],
  }).compile();
  return ref.get(UsersService);
}

describe('UsersService.findAll (OS-160)', () => {
  it('paginates and reports the account-wide total', async () => {
    const account = await insertAccount(db);
    for (let i = 0; i < 25; i++) {
      await insertUser(db, { accountId: account.id });
    }
    const service = await build();

    const first = await service.findAll(10, 0, account.id);
    expect(first.items).toHaveLength(10);
    expect(first).toMatchObject({ total: 25, limit: 10, offset: 0 });
    expect(first.items[0]?.roles).toEqual([]);

    const third = await service.findAll(10, 20, account.id);
    expect(third.items).toHaveLength(5);
  });

  it('clamps limit to 100 and floors a negative offset', async () => {
    const account = await insertAccount(db);
    await insertUser(db, { accountId: account.id });
    const service = await build();

    const page = await service.findAll(999, -5, account.id);
    expect(page).toMatchObject({ limit: 100, offset: 0 });
  });

  it('filters by q on first name, last name or email, case-insensitive', async () => {
    const account = await insertAccount(db);
    await insertUser(db, {
      accountId: account.id,
      firstname: 'Walter',
      lastname: 'Skinner',
      email: 'walter@fbi.test',
    });
    await insertUser(db, {
      accountId: account.id,
      firstname: 'Dana',
      lastname: 'Scully',
      email: 'dana@fbi.test',
    });
    const service = await build();

    expect((await service.findAll(20, 0, account.id, 'skinner')).total).toBe(1);
    expect((await service.findAll(20, 0, account.id, 'DANA')).total).toBe(1);
    expect((await service.findAll(20, 0, account.id, 'fbi.test')).total).toBe(
      2,
    );
    expect((await service.findAll(20, 0, account.id, 'nobody')).total).toBe(0);
  });

  it('is scoped to the account', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    await insertUser(db, { accountId: a.id });
    await insertUser(db, { accountId: b.id });
    const service = await build();

    const page = await service.findAll(20, 0, a.id);
    expect(page.total).toBe(1);
    expect(page.items[0]?.accountId).toBe(a.id);
  });
});
