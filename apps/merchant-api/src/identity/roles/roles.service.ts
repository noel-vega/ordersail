import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { type DbTransaction } from 'src/shared/database/database.types';
import {
  and,
  type db as Db,
  eq,
  inArray,
  isUniqueViolation,
  permissionsTable,
  rolePermissionsTable,
  rolesTable,
  userRolesTable,
} from 'db/identity';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { Role } from './entities/role.entity';
import { RoleDetail } from './entities/role-detail.entity';
import { resolveOwned } from '../shared/resolve-owned.util';
import { groupBy } from '../shared/group-by.util';
import { assertCanGrant } from '../shared/assert-can-grant.util';
import { getPermissionKeysForRoles } from '../shared/get-permission-keys-for-roles.util';
import { PermissionsService } from '../permissions/permissions.service';

// narrowed to only what getPermissionsByRoleId actually calls, so both
// this.db and a transaction handle (which lacks this.db's $client: Pool)
// satisfy it structurally
type Queryable = Pick<typeof Db, 'select'>;

@Injectable()
export class RolesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: typeof Db,
    private readonly permissionsService: PermissionsService,
  ) {}

  async create(
    dto: CreateRoleDto,
    accountId: number,
    callerUserId: number,
    callerGrantedPermissions: Set<string> | undefined,
  ): Promise<RoleDetail> {
    try {
      return await this.db.transaction(async (tx) => {
        const [role] = await tx
          .insert(rolesTable)
          .values({
            accountId,
            name: dto.name,
            description: dto.description ?? null,
          })
          .returning();

        const permissions = await this.resolvePermissions(
          tx,
          dto.permissionKeys,
        );
        await this.assertGrantable(tx, permissions, {
          callerUserId,
          callerGrantedPermissions,
        });
        if (permissions.length > 0) {
          await tx
            .insert(rolePermissionsTable)
            .values(
              permissions.map((p) => ({ roleId: role.id, permissionId: p.id })),
            );
        }

        return { ...role, permissions };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('A role with this name already exists');
      }
      throw err;
    }
  }

  // an account's role list is a small, bounded reference list, not a feed —
  // always returns every role, no pagination
  async findAll(accountId: number): Promise<RoleDetail[]> {
    const roles = await this.db
      .select()
      .from(rolesTable)
      .where(eq(rolesTable.accountId, accountId))
      .orderBy(rolesTable.name);

    const permissionsByRole = await this.getPermissionsByRoleId(
      roles.map((r) => r.id),
      accountId,
    );

    return roles.map((role) => ({
      ...role,
      permissions: permissionsByRole.get(role.id) ?? [],
    }));
  }

  async findOne(
    id: number,
    accountId: number,
  ): Promise<RoleDetail | undefined> {
    const [role] = await this.db
      .select()
      .from(rolesTable)
      .where(and(eq(rolesTable.id, id), eq(rolesTable.accountId, accountId)));

    if (!role) return undefined;

    const permissionsByRole = await this.getPermissionsByRoleId(
      [role.id],
      accountId,
    );
    return { ...role, permissions: permissionsByRole.get(role.id) ?? [] };
  }

  async update(
    id: number,
    dto: UpdateRoleDto,
    accountId: number,
    callerUserId: number,
    callerGrantedPermissions: Set<string> | undefined,
  ): Promise<RoleDetail | undefined> {
    const [existing] = await this.db
      .select()
      .from(rolesTable)
      .where(and(eq(rolesTable.id, id), eq(rolesTable.accountId, accountId)));

    if (!existing) return undefined;
    if (existing.isSystem) {
      throw new ForbiddenException('The Owner role cannot be edited');
    }

    try {
      return await this.db.transaction(async (tx) => {
        const [role] = await tx
          .update(rolesTable)
          .set({
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.description !== undefined
              ? { description: dto.description }
              : {}),
            updatedAt: new Date(),
          })
          .where(
            and(eq(rolesTable.id, id), eq(rolesTable.accountId, accountId)),
          )
          .returning();

        let permissions: Awaited<ReturnType<typeof this.resolvePermissions>>;
        if (dto.permissionKeys !== undefined) {
          // only permissions genuinely new to this role need the caller to
          // hold them — a caller shouldn't be blocked from renaming a role
          // just because they don't personally hold everything it already
          // has. Both reads are independent of each other and of the
          // delete below, so run them together.
          const [existingRows, resolvedPermissions] = await Promise.all([
            getPermissionKeysForRoles(tx, [id]),
            this.resolvePermissions(tx, dto.permissionKeys),
          ]);
          const existingKeys = new Set(existingRows);
          await tx
            .delete(rolePermissionsTable)
            .where(eq(rolePermissionsTable.roleId, id));
          permissions = resolvedPermissions;
          await this.assertGrantable(tx, permissions, {
            callerUserId,
            callerGrantedPermissions,
            existingKeys,
          });
          if (permissions.length > 0) {
            await tx
              .insert(rolePermissionsTable)
              .values(
                permissions.map((p) => ({ roleId: id, permissionId: p.id })),
              );
          }
        } else {
          // permissionKeys wasn't provided, so role_permissions is untouched
          // by this transaction — but still read through tx rather than
          // this.db, to avoid holding a second pooled connection open for
          // the same in-flight request
          const byRole = await this.getPermissionsByRoleId([id], accountId, tx);
          permissions = byRole.get(id) ?? [];
        }

        return { ...role, permissions };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('A role with this name already exists');
      }
      throw err;
    }
  }

  // the role row is locked FOR UPDATE for the whole transaction — Postgres
  // already takes an implicit FOR KEY SHARE lock on a referenced row
  // whenever a referencing row is inserted (exactly what a concurrent role
  // assignment does to user_roles), so this serializes against that insert
  // instead of racing the assignment check against it
  async remove(id: number, accountId: number): Promise<Role | undefined> {
    return await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(rolesTable)
        .where(and(eq(rolesTable.id, id), eq(rolesTable.accountId, accountId)))
        .for('update');

      if (!existing) return undefined;
      if (existing.isSystem) {
        throw new ForbiddenException('The Owner role cannot be deleted');
      }

      const [assignment] = await tx
        .select({ userId: userRolesTable.userId })
        .from(userRolesTable)
        .where(eq(userRolesTable.roleId, id))
        .limit(1);

      if (assignment) {
        throw new ConflictException(
          'This role is still assigned to staff — reassign them before deleting it',
        );
      }

      const [role] = await tx
        .delete(rolesTable)
        .where(and(eq(rolesTable.id, id), eq(rolesTable.accountId, accountId)))
        .returning();

      return role;
    });
  }

  // seeds the account's non-deletable "Owner" role with every permission
  // currently in the catalog, and assigns it to the newly created owner.
  // Takes the caller's transaction handle so it's atomic with account/user
  // creation in AccountService.provision().
  async createSystemRole(
    tx: DbTransaction,
    accountId: number,
    ownerUserId: number,
  ) {
    const [role] = await tx
      .insert(rolesTable)
      .values({
        accountId,
        name: 'Owner',
        description: 'Full access to everything',
        isSystem: true,
      })
      .returning();

    const allPermissions = await tx
      .select({ id: permissionsTable.id })
      .from(permissionsTable);
    if (allPermissions.length > 0) {
      await tx
        .insert(rolePermissionsTable)
        .values(
          allPermissions.map((p) => ({ roleId: role.id, permissionId: p.id })),
        );
    }

    await tx
      .insert(userRolesTable)
      .values({ userId: ownerUserId, roleId: role.id });

    return role;
  }

  private async resolvePermissions(
    tx: DbTransaction,
    permissionKeys: string[],
  ) {
    return resolveOwned(
      permissionKeys,
      (keys) =>
        tx
          .select()
          .from(permissionsTable)
          .where(inArray(permissionsTable.key, keys)),
      'One or more permission keys are invalid',
    );
  }

  // two independent rules: (1) a caller can never grant a permission they
  // don't hold themselves, and (2) only the Owner role may ever hold every
  // permission — the Owner role already supports multiple holders, so
  // there's no legitimate need for a second "full access" role, and
  // disallowing it outright means every other Owner-equivalence check in
  // this codebase can keep using isSystem as a complete proxy
  private async assertGrantable(
    tx: DbTransaction,
    permissions: { key: string }[],
    options: {
      callerUserId: number;
      callerGrantedPermissions: Set<string> | undefined;
      existingKeys?: Set<string>;
    },
  ) {
    const granted =
      options.callerGrantedPermissions ??
      (await this.permissionsService.getEffectivePermissionKeys(
        options.callerUserId,
      ));
    const existingKeys = options.existingKeys ?? new Set<string>();
    const newlyGranted = permissions.filter((p) => !existingKeys.has(p.key));
    assertCanGrant(
      newlyGranted.map((p) => p.key),
      granted,
    );

    const catalogSize = (
      await tx.select({ id: permissionsTable.id }).from(permissionsTable)
    ).length;
    if (permissions.length >= catalogSize) {
      throw new ForbiddenException(
        'A custom role cannot hold every permission — assign the Owner role instead',
      );
    }
  }

  // batched: one query for every role's permissions instead of one per
  // role. `queryable` defaults to this.db but also accepts a transaction
  // handle, so callers mid-transaction (see update()) can read through it
  // instead of opening a second pooled connection.
  private async getPermissionsByRoleId(
    roleIds: number[],
    accountId: number,
    queryable: Queryable = this.db,
  ) {
    if (roleIds.length === 0)
      return new Map<number, (typeof permissionsTable.$inferSelect)[]>();

    const rows = await queryable
      .select({
        roleId: rolePermissionsTable.roleId,
        permission: permissionsTable,
      })
      .from(rolePermissionsTable)
      .innerJoin(rolesTable, eq(rolesTable.id, rolePermissionsTable.roleId))
      .innerJoin(
        permissionsTable,
        eq(permissionsTable.id, rolePermissionsTable.permissionId),
      )
      .where(
        and(
          inArray(rolePermissionsTable.roleId, roleIds),
          eq(rolesTable.accountId, accountId),
        ),
      );

    return groupBy(
      rows,
      (row) => row.roleId,
      (row) => row.permission,
    );
  }
}
