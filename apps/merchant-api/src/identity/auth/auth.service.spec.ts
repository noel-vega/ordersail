import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConflictException } from '@nestjs/common';
import { useTestDb } from 'test-support';
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
import { RolesService } from '../roles/roles.service';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';

const db = useTestDb();

async function build() {
  const ref = await Test.createTestingModule({
    providers: [
      AuthService,
      { provide: DRIZZLE, useValue: db },
      {
        provide: JwtService,
        useValue: new JwtService({ secret: 'test-secret' }),
      },
      // signup() never touches UsersService
      { provide: UsersService, useValue: {} },
      // real RolesService for createSystemRole; its PermissionsService dep is
      // unused on that path
      { provide: RolesService, useValue: new RolesService(db, {} as never) },
    ],
  }).compile();
  return ref.get(AuthService);
}

const signupDto = {
  businessName: 'Cactus Coffee',
  firstName: 'Dana',
  lastName: 'Scully',
  email: 'dana@cactus.test',
  phone: '5555550100',
  password: 'supersecret',
};

describe('AuthService.signup — first-run seed (OS-173)', () => {
  it('seeds the account, api key, Default location, Owner user + role', async () => {
    // permissions are normally upserted at boot by PermissionsService
    await db.insert(permissionsTable).values(PERMISSIONS_CATALOG);
    const service = await build();

    const result = await service.signup(signupDto);
    expect(result.email).toBe(signupDto.email);
    expect(typeof result.accountId).toBe('number');
    expect(typeof result.access_token).toBe('string');

    const [account] = await db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.id, result.accountId));
    expect(account).toMatchObject({ name: 'Cactus Coffee' });

    const apiKeys = await db
      .select()
      .from(accountApiKeysTable)
      .where(eq(accountApiKeysTable.accountId, result.accountId));
    expect(apiKeys).toHaveLength(1);
    expect(apiKeys[0]).toMatchObject({ label: null, revokedAt: null });
    expect(apiKeys[0]?.key).toMatch(/^sfk_/);

    const locations = await db
      .select()
      .from(locationsTable)
      .where(eq(locationsTable.accountId, result.accountId));
    expect(locations).toHaveLength(1);
    expect(locations[0]).toMatchObject({ name: 'Default', addressLine1: null });

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.accountId, result.accountId));
    if (!user) throw new Error('owner user not seeded');
    expect(user.email).toBe(signupDto.email);
    expect(user.password).not.toBe(signupDto.password); // hashed

    const [role] = await db
      .select()
      .from(rolesTable)
      .where(eq(rolesTable.accountId, result.accountId));
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

  it('rejects a duplicate email with a ConflictException', async () => {
    const service = await build();
    await service.signup(signupDto);
    await expect(service.signup(signupDto)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
