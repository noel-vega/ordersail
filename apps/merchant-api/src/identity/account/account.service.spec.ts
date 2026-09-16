import { useTestDb, insertAccount } from 'test-support';
import { accountsTable, eq } from 'db/identity';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { Test } from '@nestjs/testing';
import { AccountService } from './account.service';

const db = useTestDb();

async function build() {
  const ref = await Test.createTestingModule({
    providers: [AccountService, { provide: DRIZZLE, useValue: db }],
  }).compile();
  return ref.get(AccountService);
}

describe('AccountService.update — requireMfa toggle (OS-473)', () => {
  it('sets requireMfaAt when requireMfa: true', async () => {
    const account = await insertAccount(db);
    const service = await build();

    const result = await service.update(account.id, { requireMfa: true });

    expect(result.requireMfaAt).not.toBeNull();
  });

  it('clears requireMfaAt when requireMfa: false', async () => {
    const account = await insertAccount(db);
    const service = await build();
    await service.update(account.id, { requireMfa: true });

    const result = await service.update(account.id, { requireMfa: false });

    expect(result.requireMfaAt).toBeNull();
  });

  it('leaves requireMfaAt untouched when requireMfa is omitted', async () => {
    const account = await insertAccount(db);
    const service = await build();
    await service.update(account.id, { requireMfa: true });

    const result = await service.update(account.id, { phone: '5555559999' });

    expect(result.requireMfaAt).not.toBeNull();
    expect(result.phone).toBe('5555559999');
  });

  it('still updates phone/email alongside the toggle', async () => {
    const account = await insertAccount(db);
    const service = await build();

    const result = await service.update(account.id, {
      requireMfa: true,
      phone: '5555551234',
      email: 'new@store.test',
    });

    expect(result.requireMfaAt).not.toBeNull();
    expect(result.phone).toBe('5555551234');
    expect(result.email).toBe('new@store.test');

    const [row] = await db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.id, account.id));
    expect(row?.requireMfaAt).not.toBeNull();
  });
});
