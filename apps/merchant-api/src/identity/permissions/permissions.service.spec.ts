import {
  PERMISSIONS_CATALOG,
  eq,
  permissionsTable,
  rolePermissionsTable,
} from 'db/identity';
import {
  assignRole,
  insertAccount,
  insertRole,
  insertUser,
  seedPermissionsCatalog,
  useTestDb,
} from 'test-support';
import { PermissionsService } from './permissions.service';

const db = useTestDb();
const service = () => new PermissionsService(db);

describe('PermissionsService.onModuleInit (OS-180)', () => {
  it('seeds the catalog and backfills every isSystem role with every key', async () => {
    const account = await insertAccount(db);
    // an Owner role that predates some catalog keys — only holds a subset
    const owner = await insertRole(db, {
      accountId: account.id,
      name: 'Owner',
      isSystem: true,
      permissionKeys: [], // catalog not seeded yet → no perms
    });

    await service().onModuleInit();

    const catalog = await db.select().from(permissionsTable);
    expect(catalog).toHaveLength(PERMISSIONS_CATALOG.length);

    const ownerPerms = await db
      .select()
      .from(rolePermissionsTable)
      .where(eq(rolePermissionsTable.roleId, owner.id));
    expect(ownerPerms).toHaveLength(PERMISSIONS_CATALOG.length);
  });

  it('leaves non-system roles untouched and is idempotent', async () => {
    const account = await insertAccount(db);
    await seedPermissionsCatalog(db);
    const limited = await insertRole(db, {
      accountId: account.id,
      permissionKeys: ['orders:read'],
    });

    await service().onModuleInit();
    await service().onModuleInit();

    const perms = await db
      .select()
      .from(rolePermissionsTable)
      .where(eq(rolePermissionsTable.roleId, limited.id));
    expect(perms).toHaveLength(1);
  });
});

describe('PermissionsService.getEffectivePermissionKeys (OS-180)', () => {
  it('returns the union of keys across every role the user holds', async () => {
    const account = await insertAccount(db);
    await seedPermissionsCatalog(db);
    const user = await insertUser(db, { accountId: account.id });
    const a = await insertRole(db, {
      accountId: account.id,
      permissionKeys: ['orders:read', 'orders:write'],
    });
    const b = await insertRole(db, {
      accountId: account.id,
      permissionKeys: ['orders:write', 'products:read'],
    });
    await assignRole(db, { userId: user.id, roleId: a.id });
    await assignRole(db, { userId: user.id, roleId: b.id });

    const keys = await service().getEffectivePermissionKeys(user.id);
    expect([...keys].sort()).toEqual([
      'orders:read',
      'orders:write',
      'products:read',
    ]);
  });

  it('is empty for a user with no roles', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, { accountId: account.id });
    expect((await service().getEffectivePermissionKeys(user.id)).size).toBe(0);
  });

  it('is empty for a deactivated user even with roles (OS-184)', async () => {
    const account = await insertAccount(db);
    await seedPermissionsCatalog(db);
    const user = await insertUser(db, {
      accountId: account.id,
      deactivatedAt: new Date(),
    });
    const role = await insertRole(db, {
      accountId: account.id,
      permissionKeys: ['orders:read', 'orders:write'],
    });
    await assignRole(db, { userId: user.id, roleId: role.id });

    expect((await service().getEffectivePermissionKeys(user.id)).size).toBe(0);
  });
});
