import { insertAccount, insertStorefrontOrigin, useTestDb } from 'test-support';
import { CorsOriginsService, LOCAL_DEV_ORIGIN } from './cors-origins.service';

const db = useTestDb();

describe('CorsOriginsService (OS-437)', () => {
  it('always allows the local dev origin, even with no registrations', async () => {
    const service = new CorsOriginsService(db);
    await service.refresh();

    expect(service.isAllowed(LOCAL_DEV_ORIGIN)).toBe(true);
  });

  it('rejects an origin that has not been registered', async () => {
    const service = new CorsOriginsService(db);
    await service.refresh();

    expect(service.isAllowed('https://not-registered.example.com')).toBe(false);
  });

  it('allows an origin once it is registered', async () => {
    const account = await insertAccount(db);
    await insertStorefrontOrigin(db, {
      accountId: account.id,
      origin: 'https://shop.example.com',
    });
    const service = new CorsOriginsService(db);
    await service.refresh();

    expect(service.isAllowed('https://shop.example.com')).toBe(true);
  });

  it('reflects origins registered by any account, not just one', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    await insertStorefrontOrigin(db, {
      accountId: a.id,
      origin: 'https://a.test',
    });
    await insertStorefrontOrigin(db, {
      accountId: b.id,
      origin: 'https://b.test',
    });
    const service = new CorsOriginsService(db);
    await service.refresh();

    expect(service.isAllowed('https://a.test')).toBe(true);
    expect(service.isAllowed('https://b.test')).toBe(true);
  });
});
