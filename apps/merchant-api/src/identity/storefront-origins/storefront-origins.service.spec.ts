import { Test } from '@nestjs/testing';
import { insertAccount, insertStorefrontOrigin, useTestDb } from 'test-support';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { StorefrontOriginsService } from './storefront-origins.service';

const db = useTestDb();

async function build() {
  const ref = await Test.createTestingModule({
    providers: [StorefrontOriginsService, { provide: DRIZZLE, useValue: db }],
  }).compile();
  return ref.get(StorefrontOriginsService);
}

describe('StorefrontOriginsService.createForAccount (OS-436)', () => {
  it('creates and normalizes a well-formed origin', async () => {
    const account = await insertAccount(db);
    const service = await build();

    const created = await service.createForAccount(
      account.id,
      'https://shop.example.com/',
    );

    expect(created).toMatchObject({ origin: 'https://shop.example.com' });
  });

  it('rejects a malformed origin', async () => {
    const account = await insertAccount(db);
    const service = await build();

    await expect(
      service.createForAccount(account.id, 'not-a-url'),
    ).rejects.toThrow();
  });

  it('rejects an origin with a path', async () => {
    const account = await insertAccount(db);
    const service = await build();

    await expect(
      service.createForAccount(account.id, 'https://shop.example.com/store'),
    ).rejects.toThrow();
  });

  it('rejects a duplicate origin for the same account', async () => {
    const account = await insertAccount(db);
    await insertStorefrontOrigin(db, {
      accountId: account.id,
      origin: 'https://shop.example.com',
    });
    const service = await build();

    await expect(
      service.createForAccount(account.id, 'https://shop.example.com'),
    ).rejects.toThrow();
  });

  it('allows the same origin to be registered by a different account', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    await insertStorefrontOrigin(db, {
      accountId: a.id,
      origin: 'https://shop.example.com',
    });
    const service = await build();

    await expect(
      service.createForAccount(b.id, 'https://shop.example.com'),
    ).resolves.toMatchObject({ origin: 'https://shop.example.com' });
  });
});

describe('StorefrontOriginsService.listForAccount (OS-436)', () => {
  it('is scoped to the account', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    await insertStorefrontOrigin(db, { accountId: b.id });
    const service = await build();

    const created = await service.createForAccount(
      a.id,
      'https://shop-a.example.com',
    );

    const listA = await service.listForAccount(a.id);
    expect(listA).toEqual([expect.objectContaining({ id: created.id })]);

    const listB = await service.listForAccount(b.id);
    expect(listB.map((o) => o.id)).not.toContain(created.id);
  });
});

describe('StorefrontOriginsService.deleteForAccount (OS-436)', () => {
  it('deletes an owned origin and removes it from listForAccount', async () => {
    const account = await insertAccount(db);
    const origin = await insertStorefrontOrigin(db, { accountId: account.id });
    const service = await build();

    const deleted = await service.deleteForAccount(origin.id, account.id);

    expect(deleted).toMatchObject({ id: origin.id });
    expect(await service.listForAccount(account.id)).toEqual([]);
  });

  it("returns null for another account's origin and leaves it intact", async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const bOrigin = await insertStorefrontOrigin(db, { accountId: b.id });
    const service = await build();

    expect(await service.deleteForAccount(bOrigin.id, a.id)).toBeNull();
    expect(await service.listForAccount(b.id)).toEqual([
      expect.objectContaining({ id: bOrigin.id }),
    ]);
  });

  it('returns null for a missing id', async () => {
    const account = await insertAccount(db);
    const service = await build();

    expect(await service.deleteForAccount(999999, account.id)).toBeNull();
  });
});
