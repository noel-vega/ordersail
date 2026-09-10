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

describe('ApiKeysService.revokeForAccount (OS-170)', () => {
  it('revokes an owned key and removes it from listForAccount', async () => {
    const account = await insertAccount(db);
    const key = await insertApiKey(db, { accountId: account.id });
    const service = await build();

    const revoked = await service.revokeForAccount(key.id, account.id);

    expect(revoked).toMatchObject({ id: key.id, key: key.key });
    expect(await service.listForAccount(account.id)).toEqual([]);
  });

  it('returns null for another account key and leaves it active', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const bKey = await insertApiKey(db, { accountId: b.id });
    const service = await build();

    expect(await service.revokeForAccount(bKey.id, a.id)).toBeNull();
    expect(await service.listForAccount(b.id)).toEqual([
      expect.objectContaining({ id: bKey.id }),
    ]);
  });

  it('returns null for a missing id', async () => {
    const account = await insertAccount(db);
    const service = await build();

    expect(await service.revokeForAccount(999999, account.id)).toBeNull();
  });

  it('returns null when the key is already revoked', async () => {
    const account = await insertAccount(db);
    const key = await insertApiKey(db, { accountId: account.id });
    const service = await build();

    await service.revokeForAccount(key.id, account.id);
    expect(await service.revokeForAccount(key.id, account.id)).toBeNull();
  });
});
