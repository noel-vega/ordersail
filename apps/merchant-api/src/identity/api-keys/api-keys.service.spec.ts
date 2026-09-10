import { Test } from '@nestjs/testing';
import { insertAccount, insertApiKey, useTestDb } from 'test-support';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { ApiKeysService } from './api-keys.service';

const db = useTestDb();

async function build() {
  const ref = await Test.createTestingModule({
    providers: [ApiKeysService, { provide: DRIZZLE, useValue: db }],
  }).compile();
  return ref.get(ApiKeysService);
}

describe('ApiKeysService.createForAccount (OS-169)', () => {
  it('creates a key with a label', async () => {
    const account = await insertAccount(db);
    const service = await build();

    const created = await service.createForAccount(account.id, 'CI deploy');

    expect(created).toMatchObject({ label: 'CI deploy' });
    expect(created.key).toMatch(/^sfk_/);
    expect(created.id).toEqual(expect.any(Number));
  });

  it('creates a key with no label', async () => {
    const account = await insertAccount(db);
    const service = await build();

    const created = await service.createForAccount(account.id);

    expect(created.label).toBeNull();
    expect(created.key).toMatch(/^sfk_/);
  });

  it('generates a unique key per call', async () => {
    const account = await insertAccount(db);
    const service = await build();

    const a = await service.createForAccount(account.id);
    const b = await service.createForAccount(account.id);

    expect(a.key).not.toEqual(b.key);
  });

  it('is scoped to the account and shows up in listForAccount', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    await insertApiKey(db, { accountId: b.id });
    const service = await build();

    const created = await service.createForAccount(a.id, 'A only');

    const listA = await service.listForAccount(a.id);
    expect(listA).toEqual([
      expect.objectContaining({ id: created.id, key: created.key }),
    ]);

    const listB = await service.listForAccount(b.id);
    expect(listB.map((k) => k.id)).not.toContain(created.id);
  });
});
