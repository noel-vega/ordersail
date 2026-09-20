import { useTestDb, insertAccount } from 'test-support';
import {
  PERMISSIONS_CATALOG,
  accountApiKeysTable,
  accountsTable,
  eq,
  permissionsTable,
  rolePermissionsTable,
  rolesTable,
  userRolesTable,
  usersTable,
} from 'db/identity';
import { locationsTable } from 'db/stock';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RolesService } from '../roles/roles.service';
import { AccountService } from './account.service';

const db = useTestDb();

async function build() {
  const ref = await Test.createTestingModule({
    providers: [
      AccountService,
      { provide: DRIZZLE, useValue: db },
      // real RolesService for createSystemRole; its PermissionsService dep is
      // unused on that path
      { provide: RolesService, useValue: new RolesService(db, {} as never) },
    ],
  }).compile();
  return ref.get(AccountService);
}

const provisionInput = {
  businessName: 'Cactus Coffee',
  firstName: 'Dana',
  lastName: 'Scully',
  email: 'dana@cactus.test',
  phone: '5555550100',
  password: 'supersecret',
};

// moved from AuthService.signup with the transaction it covers (OS-507)
describe('AccountService.provision — first-run seed (OS-173)', () => {
  it('seeds the account, api key, Default location, Owner user + role', async () => {
    // permissions are normally upserted at boot by PermissionsService
    await db.insert(permissionsTable).values(PERMISSIONS_CATALOG);
    const service = await build();

    const result = await service.provision(provisionInput);
    expect(result.owner.email).toBe(provisionInput.email);
    expect(typeof result.account.id).toBe('number');

    const [account] = await db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.id, result.account.id));
    expect(account).toMatchObject({ name: 'Cactus Coffee' });

    const apiKeys = await db
      .select()
      .from(accountApiKeysTable)
      .where(eq(accountApiKeysTable.accountId, result.account.id));
    expect(apiKeys).toHaveLength(1);
    expect(apiKeys[0]).toMatchObject({ label: null, revokedAt: null });
    expect(apiKeys[0]?.key).toMatch(/^sfk_/);

    const locations = await db
      .select()
      .from(locationsTable)
      .where(eq(locationsTable.accountId, result.account.id));
    expect(locations).toHaveLength(1);
    expect(locations[0]).toMatchObject({ name: 'Default', addressLine1: null });

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.accountId, result.account.id));
    if (!user) throw new Error('owner user not seeded');
    expect(user.email).toBe(provisionInput.email);
    expect(user.password).not.toBe(provisionInput.password); // hashed

    const [role] = await db
      .select()
      .from(rolesTable)
      .where(eq(rolesTable.accountId, result.account.id));
    if (!role) throw new Error('Owner role not seeded');
    expect(role).toMatchObject({ name: 'Owner', isSystem: true });

    const userRoles = await db
      .select()
      .from(userRolesTable)
      .where(eq(userRolesTable.userId, user.id));
    expect(userRoles).toEqual([expect.objectContaining({ roleId: role.id })]);

    const rolePerms = await db
      .select()
      .from(rolePermissionsTable)
      .where(eq(rolePermissionsTable.roleId, role.id));
    expect(rolePerms).toHaveLength(PERMISSIONS_CATALOG.length);
  });

  it('refuses an email that is already taken as a conflict, and rolls the whole tenant back', async () => {
    const service = await build();
    await service.provision(provisionInput);

    const refusal = await service
      .provision({ ...provisionInput, businessName: 'Second Shop' })
      .catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(ConflictException);
    expect(refusal).toMatchObject({ message: 'Email already in use' });

    const accounts = await db.select().from(accountsTable);
    expect(accounts).toHaveLength(1);
    expect(await db.select().from(locationsTable)).toHaveLength(1);
  });
});

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
