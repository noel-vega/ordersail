import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DRIZZLE } from 'src/shared/database/database.constants';
import {
  and,
  type db as Db,
  eq,
  isNull,
  PERMISSIONS_CATALOG,
  permissionsTable,
  rolePermissionsTable,
  rolesTable,
  sql,
  userRolesTable,
  usersTable,
} from 'db/identity';

@Injectable()
export class PermissionsService implements OnModuleInit {
  constructor(@Inject(DRIZZLE) private readonly db: typeof Db) {}

  // seeds/updates the fixed permission catalog on every boot. Rows for keys
  // removed from PERMISSIONS_CATALOG are left in place rather than deleted,
  // so a bad deploy can't destroy role_permissions references.
  async onModuleInit() {
    if (PERMISSIONS_CATALOG.length === 0) return;

    await this.db
      .insert(permissionsTable)
      .values(PERMISSIONS_CATALOG)
      .onConflictDoUpdate({
        target: permissionsTable.key,
        set: {
          resource: sql`excluded.resource`,
          action: sql`excluded.action`,
          description: sql`excluded.description`,
        },
      });

    await this.backfillSystemRoles();
  }

  // every "Owner" (isSystem) role holds every permission by construction, but
  // createSystemRole only grants the full set at role-creation time — a key
  // added to the catalog after an account signed up would never reach that
  // account's Owner. Idempotently top them up on every boot.
  private async backfillSystemRoles() {
    const [systemRoles, allPermissions] = await Promise.all([
      this.db
        .select({ id: rolesTable.id })
        .from(rolesTable)
        .where(eq(rolesTable.isSystem, true)),
      this.db.select({ id: permissionsTable.id }).from(permissionsTable),
    ]);

    if (systemRoles.length === 0 || allPermissions.length === 0) return;

    await this.db
      .insert(rolePermissionsTable)
      .values(
        systemRoles.flatMap((role) =>
          allPermissions.map((permission) => ({
            roleId: role.id,
            permissionId: permission.id,
          })),
        ),
      )
      .onConflictDoNothing();
  }

  async findAll() {
    return await this.db
      .select()
      .from(permissionsTable)
      .orderBy(permissionsTable.resource, permissionsTable.action);
  }

  // the guard's core query: every permission key granted to a user through
  // any role they hold. Live DB lookup, not cached — see the RBAC plan for
  // why (stale embedded permissions would delay revoking a fired staffer).
  async getEffectivePermissionKeys(userId: number): Promise<Set<string>> {
    const rows = await this.db
      .selectDistinct({ key: permissionsTable.key })
      .from(userRolesTable)
      .innerJoin(
        rolePermissionsTable,
        eq(rolePermissionsTable.roleId, userRolesTable.roleId),
      )
      .innerJoin(
        permissionsTable,
        eq(permissionsTable.id, rolePermissionsTable.permissionId),
      )
      // a deactivated staff member keeps their role rows but loses every
      // effective permission, so any @RequirePermissions route 403s for them
      .innerJoin(usersTable, eq(usersTable.id, userRolesTable.userId))
      .where(
        and(
          eq(userRolesTable.userId, userId),
          isNull(usersTable.deactivatedAt),
        ),
      );

    return new Set(rows.map((row) => row.key));
  }
}
