import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  insertAccount,
  insertInventory,
  insertLocation,
  insertProductWithVariants,
  useTestDb,
} from 'test-support';
import { DRIZZLE } from 'src/shared/database/database.constants';
// posDevicesTable lives outside stock's db read-graph (see
// LocationsService.remove()'s comment) — spec files are exempt from the
// eslint-plugin-boundaries data-access rule, so this direct import is only
// valid here, to set up the "blocked by a cross-context reference" case.
import { posDevicesTable } from 'db';
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

describe('LocationsService.remove (OS-188)', () => {
  it('deletes a location with no references', async () => {
    const account = await insertAccount(db);
    const location = await insertLocation(db, { accountId: account.id });
    const service = await build();

    const removed = await service.remove(location.id, account.id);
    expect(removed?.id).toBe(location.id);
  });

  it('blocks deleting a location that still has inventory', async () => {
    const account = await insertAccount(db);
    const location = await insertLocation(db, { accountId: account.id });
    const [variant] = await insertProductWithVariants(db, {
      accountId: account.id,
      variants: [{}],
    });
    await insertInventory(db, [
      { variantId: variant.id, locationId: location.id, stock: 5 },
    ]);
    const service = await build();

    await expect(service.remove(location.id, account.id)).rejects.toThrow(
      ConflictException,
    );
  });

  // pos_devices/fulfillments live outside stock's db read-graph — remove()
  // guards them by catching the DB's own restrict-FK violation rather than
  // prechecking (see the method's doc comment). Covering pos_devices here
  // also exercises the identical catch path fulfillments would hit.
  it('blocks deleting a location with a POS device paired to it', async () => {
    const account = await insertAccount(db);
    const location = await insertLocation(db, { accountId: account.id });
    await db.insert(posDevicesTable).values({
      accountId: account.id,
      locationId: location.id,
      name: 'Front register',
    });
    const service = await build();

    await expect(service.remove(location.id, account.id)).rejects.toThrow(
      ConflictException,
    );
  });

  it('returns undefined for a location outside the account', async () => {
    const account = await insertAccount(db);
    const other = await insertAccount(db);
    const location = await insertLocation(db, { accountId: account.id });
    const service = await build();

    expect(await service.remove(location.id, other.id)).toBeUndefined();
  });
});
