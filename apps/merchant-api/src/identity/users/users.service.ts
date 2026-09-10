import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserProfileDto } from './dto/update-user-profile.dto';
import { User, UserRoleSummary, type UserStatus } from './entities/user.entity';
import { PaginatedUsers } from './entities/paginated-users.entity';
import { EmailService } from 'src/shared/email/email.service';
import { resolvePageParams } from 'src/shared/pagination';
import { PermissionsService } from '../permissions/permissions.service';
import { generateToken } from '../../shared/common/generate-token.util';
import { resolveOwned } from '../shared/resolve-owned.util';
import { groupBy } from '../shared/group-by.util';
import { assertCanGrant } from '../shared/assert-can-grant.util';
import { env } from 'src/shared/env';
import { getPermissionKeysForRoles } from '../shared/get-permission-keys-for-roles.util';
import { DRIZZLE } from 'src/shared/database/database.constants';
import {
  and,
  type db as Db,
  desc,
  eq,
  ilike,
  inArray,
  isForeignKeyViolation,
  isNull,
  isUniqueViolation,
  ne,
  or,
  rolesTable,
  type SQL,
  sql,
  userInvitesTable,
  userRolesTable,
  usersTable,
} from 'db/identity';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, matches the refresh token TTL

function userStatus(row: typeof usersTable.$inferSelect): UserStatus {
  if (row.deactivatedAt) return 'deactivated';
  if (!row.password) return 'invited';
  return 'active';
}

function toUser(
  row: typeof usersTable.$inferSelect,
  roles: UserRoleSummary[],
): User {
  return {
    id: row.id,
    accountId: row.accountId,
    status: userStatus(row),
    firstName: row.firstname,
    lastName: row.lastname,
    phone: row.phone,
    email: row.email,
    roles,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: typeof Db,
    private readonly emailService: EmailService,
    private readonly permissionsService: PermissionsService,
  ) {}

  // deactivated users are excluded so sign-in refuses them exactly like a
  // wrong password — no separate "your account is disabled" signal
  async getByEmail(email: string) {
    const [user] = await this.db
      .select()
      .from(usersTable)
      .where(
        and(eq(usersTable.email, email), isNull(usersTable.deactivatedAt)),
      );

    return user;
  }

  async getByInviteToken(token: string) {
    const [row] = await this.db
      .select({ user: usersTable, expiresAt: userInvitesTable.expiresAt })
      .from(userInvitesTable)
      .innerJoin(usersTable, eq(userInvitesTable.userId, usersTable.id))
      .where(eq(userInvitesTable.token, token));

    return row;
  }

  // sets the user's real password and consumes the invite — called once
  // they follow the emailed link and choose one. Returns undefined if the
  // user no longer exists (e.g. deleted between the invite lookup and this
  // call) rather than assuming the update always finds a row.
  async activate(
    id: number,
    hashedPassword: string,
  ): Promise<User | undefined> {
    const [user] = await this.db
      .update(usersTable)
      .set({ password: hashedPassword, updatedAt: new Date() })
      .where(eq(usersTable.id, id))
      .returning();

    if (!user) return undefined;

    await this.db
      .delete(userInvitesTable)
      .where(eq(userInvitesTable.userId, id));

    const roles = await this.getRolesByUserId([user.id]);
    return toUser(user, roles.get(user.id) ?? []);
  }

  // no password is set here — the account owner invites a staff member and
  // they join later via the emailed invite link, at which point they set
  // their own. The user + invite rows are inserted together so a failure
  // partway through never leaves a user with no way to ever join. roleIds
  // is optional — a user invited with none can still log in, they just
  // can't use anything gated by @RequirePermissions until assigned a role.
  async create(
    dto: CreateUserDto,
    accountId: number,
    callerUserId: number,
    callerGrantedPermissions?: Set<string>,
  ): Promise<User> {
    // granting roles at invite time is a form of role management — someone
    // who can only invite staff (users:write) shouldn't be able to hand a
    // new hire the Owner role just because roleIds rides along on this
    // call. callerGrantedPermissions comes from PermissionsGuard's own
    // lookup for users:write on this same request (see @GrantedPermissions
    // in users.controller.ts) — falling back to a fresh query only if it's
    // ever missing, which shouldn't happen since this route is always guarded.
    let granted: Set<string> | undefined;
    if (dto.roleIds && dto.roleIds.length > 0) {
      granted =
        callerGrantedPermissions ??
        (await this.permissionsService.getEffectivePermissionKeys(
          callerUserId,
        ));
      if (!granted.has('users:manage_roles')) {
        throw new ForbiddenException(
          'Missing required permission: users:manage_roles',
        );
      }
    }

    try {
      const { user, token } = await this.db.transaction(async (tx) => {
        const [user] = await tx
          .insert(usersTable)
          .values({
            firstname: dto.firstName,
            lastname: dto.lastName,
            phone: dto.phone,
            email: dto.email,
            accountId,
          })
          .returning();

        if (dto.roleIds && dto.roleIds.length > 0) {
          const roles = await resolveOwned(
            dto.roleIds,
            (ids) =>
              tx
                .select({ id: rolesTable.id, isSystem: rolesTable.isSystem })
                .from(rolesTable)
                .where(
                  and(
                    inArray(rolesTable.id, ids),
                    eq(rolesTable.accountId, accountId),
                  ),
                ),
            'One or more roles are invalid',
          );

          // the Owner role is seeded once at signup and reassigned only via
          // the explicit PATCH /users/:id/roles flow — never handed out as
          // a side effect of a routine invite
          if (roles.some((role) => role.isSystem)) {
            throw new ForbiddenException(
              'The Owner role cannot be assigned when inviting a user',
            );
          }

          // holding users:manage_roles only means "can assign roles" — it
          // doesn't mean the caller holds the actual permissions those
          // roles carry, so assigning one is capped the same as defining one
          const grantedKeys = await getPermissionKeysForRoles(
            tx,
            roles.map((role) => role.id),
          );
          assertCanGrant(grantedKeys, granted!);

          await tx
            .insert(userRolesTable)
            .values(
              roles.map((role) => ({ userId: user.id, roleId: role.id })),
            );
        }

        const token = generateToken(32);
        await tx.insert(userInvitesTable).values({
          userId: user.id,
          token,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        });

        return { user, token };
      });

      const inviteUrl = `${env.MERCHANT_WEB_URL}/join?token=${token}`;
      await this.emailService.sendInviteEmail(user.email, {
        firstName: user.firstname,
        inviteUrl,
      });

      const roles = await this.getRolesByUserId([user.id]);
      return toUser(user, roles.get(user.id) ?? []);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('Email already in use');
      }
      if (isForeignKeyViolation(err)) {
        throw new BadRequestException('One or more roles no longer exist');
      }
      throw err;
    }
  }

  async findAll(
    limit: number,
    offset: number,
    accountId: number,
    q?: string,
  ): Promise<PaginatedUsers> {
    const { limit: take, offset: skip } = resolvePageParams(limit, offset);
    const where = this.listFilter(accountId, q);

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(usersTable)
        .where(where)
        .orderBy(desc(usersTable.createdAt), desc(usersTable.id))
        .limit(take)
        .offset(skip),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(usersTable)
        .where(where),
    ]);

    const rolesByUser = await this.getRolesByUserId(rows.map((row) => row.id));
    return {
      items: rows.map((row) => toUser(row, rolesByUser.get(row.id) ?? [])),
      total,
      limit: take,
      offset: skip,
    };
  }

  private listFilter(accountId: number, q?: string): SQL | undefined {
    const scope = eq(usersTable.accountId, accountId);
    const term = q?.trim();
    if (!term) return scope;

    const like = `%${term}%`;
    return and(
      scope,
      or(
        ilike(usersTable.firstname, like),
        ilike(usersTable.lastname, like),
        ilike(usersTable.email, like),
      ),
    );
  }

  // replaces a user's roles wholesale — an empty array strips them to none.
  // Returns undefined if the user isn't in this account, or any roleId
  // doesn't belong to it, so the controller can 404/400 appropriately.
  // Validation, the Owner-membership checks, and the mutation all run
  // inside one transaction — otherwise a role deleted between validating
  // and inserting (or between checking and losing the last Owner) leaves
  // an uncaught FK violation or an account with nobody left who can manage
  // roles at all.
  async updateRoles(
    userId: number,
    roleIds: number[],
    accountId: number,
    callerUserId: number,
    callerGrantedPermissions?: Set<string>,
  ): Promise<User | undefined> {
    const [user] = await this.db
      .select()
      .from(usersTable)
      .where(
        and(eq(usersTable.id, userId), eq(usersTable.accountId, accountId)),
      );

    if (!user) return undefined;

    let finalRoles: UserRoleSummary[] = [];

    try {
      await this.db.transaction(async (tx) => {
        const resolvedRoles =
          roleIds.length > 0
            ? await resolveOwned(
                roleIds,
                (ids) =>
                  tx
                    .select({
                      id: rolesTable.id,
                      name: rolesTable.name,
                      isSystem: rolesTable.isSystem,
                    })
                    .from(rolesTable)
                    .where(
                      and(
                        inArray(rolesTable.id, ids),
                        eq(rolesTable.accountId, accountId),
                      ),
                    ),
                'One or more roles are invalid',
              )
            : [];

        // holding users:manage_roles only means "can reassign roles" — it
        // doesn't mean the caller holds the permissions those roles carry.
        // Only check roles this call actually adds for this user: already-
        // held roles aren't a new grant, and Owner has its own stricter
        // check below.
        const currentRoleIds = new Set(
          (
            await tx
              .select({ roleId: userRolesTable.roleId })
              .from(userRolesTable)
              .where(eq(userRolesTable.userId, userId))
          ).map((row) => row.roleId),
        );
        const newlyGrantedRoleIds = resolvedRoles
          .filter((role) => !role.isSystem && !currentRoleIds.has(role.id))
          .map((role) => role.id);

        if (newlyGrantedRoleIds.length > 0) {
          const grantedKeys = await getPermissionKeysForRoles(
            tx,
            newlyGrantedRoleIds,
          );
          const granted =
            callerGrantedPermissions ??
            (await this.permissionsService.getEffectivePermissionKeys(
              callerUserId,
            ));
          assertCanGrant(grantedKeys, granted);
        }

        // locks the account's Owner role row so concurrent updateRoles()
        // calls touching Owner-role membership serialize through this one
        // point. currentlyHoldsOwner below is deliberately re-read fresh
        // here (not reused from currentRoleIds above) — a prior attempt at
        // skipping this lock in the common case, by reusing that earlier
        // unlocked read to decide whether locking was needed, reopened a
        // TOCTOU gap where a concurrent Owner-role change could go
        // unauthorized. Always lock, always re-read fresh under the lock.
        const [ownerRole] = await tx
          .select({ id: rolesTable.id })
          .from(rolesTable)
          .where(
            and(
              eq(rolesTable.accountId, accountId),
              eq(rolesTable.isSystem, true),
            ),
          )
          .for('update');

        if (!ownerRole) {
          // every account should always have one — if it doesn't, something
          // upstream is broken. Fail loudly rather than silently skipping
          // every Owner-role safeguard below (in practice unreachable: only
          // an Owner-role holder could ever have been granted
          // users:manage_roles in the first place)
          throw new ConflictException(
            'This account has no Owner role configured',
          );
        }

        const willHoldOwner = resolvedRoles.some((role) => role.isSystem);
        const [currentlyHoldsOwnerRow] = await tx
          .select({ userId: userRolesTable.userId })
          .from(userRolesTable)
          .where(
            and(
              eq(userRolesTable.userId, userId),
              eq(userRolesTable.roleId, ownerRole.id),
            ),
          )
          .limit(1);
        const currentlyHoldsOwner = Boolean(currentlyHoldsOwnerRow);

        // granting OR revoking Owner-role membership both require the
        // caller to already be an Owner — symmetric on purpose
        if (currentlyHoldsOwner !== willHoldOwner) {
          const [callerIsOwner] = await tx
            .select({ userId: userRolesTable.userId })
            .from(userRolesTable)
            .where(
              and(
                eq(userRolesTable.userId, callerUserId),
                eq(userRolesTable.roleId, ownerRole.id),
              ),
            )
            .limit(1);

          if (!callerIsOwner) {
            throw new ForbiddenException(
              'Only an existing Owner can change Owner-role membership',
            );
          }
        }

        if (currentlyHoldsOwner && !willHoldOwner) {
          const [otherHolder] = await tx
            .select({ userId: userRolesTable.userId })
            .from(userRolesTable)
            .where(
              and(
                eq(userRolesTable.roleId, ownerRole.id),
                ne(userRolesTable.userId, userId),
              ),
            )
            .limit(1);

          if (!otherHolder) {
            throw new ConflictException(
              'Cannot remove the last user holding the Owner role',
            );
          }
        }

        await tx
          .delete(userRolesTable)
          .where(eq(userRolesTable.userId, userId));
        if (resolvedRoles.length > 0) {
          await tx
            .insert(userRolesTable)
            .values(resolvedRoles.map((role) => ({ userId, roleId: role.id })));
        }

        finalRoles = resolvedRoles.map((role) => ({
          id: role.id,
          name: role.name,
        }));
      });
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        throw new BadRequestException('One or more roles no longer exist');
      }
      throw err;
    }

    return toUser(user, finalRoles);
  }

  async getById(userId: number, accountId: number): Promise<User | undefined> {
    const [user] = await this.db
      .select()
      .from(usersTable)
      .where(
        and(eq(usersTable.id, userId), eq(usersTable.accountId, accountId)),
      );

    if (!user) return undefined;

    const roles = await this.getRolesByUserId([user.id]);
    return toUser(user, roles.get(user.id) ?? []);
  }

  // name + phone only — email is the login identity and isn't editable here.
  // Any subset of fields may be present; an all-empty patch is a no-op read.
  async update(
    userId: number,
    accountId: number,
    dto: UpdateUserProfileDto,
  ): Promise<User | undefined> {
    const patch: Partial<typeof usersTable.$inferInsert> = {};
    if (dto.firstName !== undefined) patch.firstname = dto.firstName;
    if (dto.lastName !== undefined) patch.lastname = dto.lastName;
    if (dto.phone !== undefined) patch.phone = dto.phone;

    if (Object.keys(patch).length === 0) {
      return this.getById(userId, accountId);
    }

    patch.updatedAt = new Date();

    const [user] = await this.db
      .update(usersTable)
      .set(patch)
      .where(
        and(eq(usersTable.id, userId), eq(usersTable.accountId, accountId)),
      )
      .returning();

    if (!user) return undefined;

    const roles = await this.getRolesByUserId([user.id]);
    return toUser(user, roles.get(user.id) ?? []);
  }

  // deactivate (set deactivatedAt) / reactivate (clear it). Deactivating the
  // last non-deactivated holder of an isSystem (Owner) role is refused —
  // reuses the same Owner-role row lock as updateRoles so concurrent
  // deactivations serialize through one point and can't both slip past the
  // "is there another Owner?" check. Reactivating is always allowed.
  async setDeactivated(
    userId: number,
    accountId: number,
    deactivated: boolean,
  ): Promise<User | undefined> {
    const [user] = await this.db
      .select()
      .from(usersTable)
      .where(
        and(eq(usersTable.id, userId), eq(usersTable.accountId, accountId)),
      );

    if (!user) return undefined;

    const alreadyInState = deactivated
      ? user.deactivatedAt !== null
      : user.deactivatedAt === null;
    if (alreadyInState) {
      const roles = await this.getRolesByUserId([user.id]);
      return toUser(user, roles.get(user.id) ?? []);
    }

    let updated: typeof usersTable.$inferSelect | undefined;

    await this.db.transaction(async (tx) => {
      if (deactivated) {
        const [ownerRole] = await tx
          .select({ id: rolesTable.id })
          .from(rolesTable)
          .where(
            and(
              eq(rolesTable.accountId, accountId),
              eq(rolesTable.isSystem, true),
            ),
          )
          .for('update');

        if (ownerRole) {
          const [holdsOwner] = await tx
            .select({ userId: userRolesTable.userId })
            .from(userRolesTable)
            .where(
              and(
                eq(userRolesTable.userId, userId),
                eq(userRolesTable.roleId, ownerRole.id),
              ),
            )
            .limit(1);

          if (holdsOwner) {
            const [otherHolder] = await tx
              .select({ userId: userRolesTable.userId })
              .from(userRolesTable)
              .innerJoin(usersTable, eq(usersTable.id, userRolesTable.userId))
              .where(
                and(
                  eq(userRolesTable.roleId, ownerRole.id),
                  ne(userRolesTable.userId, userId),
                  isNull(usersTable.deactivatedAt),
                ),
              )
              .limit(1);

            if (!otherHolder) {
              throw new ConflictException(
                'Cannot deactivate the last active user holding the Owner role',
              );
            }
          }
        }
      }

      [updated] = await tx
        .update(usersTable)
        .set({
          deactivatedAt: deactivated ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(
          and(eq(usersTable.id, userId), eq(usersTable.accountId, accountId)),
        )
        .returning();
    });

    if (!updated) return undefined;

    const roles = await this.getRolesByUserId([updated.id]);
    return toUser(updated, roles.get(updated.id) ?? []);
  }

  // batched: one query for every user's roles instead of one per user
  private async getRolesByUserId(userIds: number[]) {
    if (userIds.length === 0) return new Map<number, UserRoleSummary[]>();

    const rows = await this.db
      .select({
        userId: userRolesTable.userId,
        id: rolesTable.id,
        name: rolesTable.name,
      })
      .from(userRolesTable)
      .innerJoin(rolesTable, eq(rolesTable.id, userRolesTable.roleId))
      .where(inArray(userRolesTable.userId, userIds));

    return groupBy(
      rows,
      (row) => row.userId,
      (row) => ({ id: row.id, name: row.name }),
    );
  }
}
