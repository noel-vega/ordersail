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
import { UserProfile } from './entities/user-profile.entity';
import { PaginatedUsers } from './entities/paginated-users.entity';
import { EmailService } from 'src/shared/email/email.service';
import { resolvePageParams } from 'src/shared/pagination';
import { PermissionsService } from '../permissions/permissions.service';
import { SessionsService } from '../auth/sessions.service';
import { EmailedLinksService } from '../emailed-links/emailed-links.service';
import { resolveOwned } from '../shared/resolve-owned.util';
import { groupBy } from '../shared/group-by.util';
import { assertCanGrant } from '../shared/assert-can-grant.util';
import { env } from 'src/shared/env';
import { getPermissionKeysForRoles } from '../shared/get-permission-keys-for-roles.util';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { type DbTransaction } from 'src/shared/database/database.types';
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
  userRolesTable,
  usersTable,
} from 'db/identity';

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

// Narrows a Staff record down to its Profile aspect (ADR 0001). Deriving it
// from User rather than selecting the three columns separately is what keeps
// "the administrator's view" and "the person's own view" from drifting into
// two different notions of what a first name is.
function toProfile(user: User): UserProfile {
  return {
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
  };
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: typeof Db,
    private readonly emailService: EmailService,
    private readonly permissionsService: PermissionsService,
    private readonly sessionsService: SessionsService,
    // An Invite is an Emailed link, so how one is made, replaced, recognised
    // and withdrawn belongs to that module; what is left here is the Staff
    // record it is about. Deactivation withdraws the other kinds through it
    // too (OS-559).
    private readonly emailedLinks: EmailedLinksService,
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

  // What following an Invite does to the Staff record: it stops being
  // pending. Runs as the effect of redeeming the Invite
  // (AuthService.acceptInvite), inside that redemption's transaction, so the
  // join and the link's disappearance are one fact — which is why `tx` is
  // required rather than optional, and why nothing here deletes the invite
  // row: the Emailed links module owns that.
  //
  // Marks the email verified (OS-470) — clicking the emailed link already
  // proves ownership of the address, so staff who join this way need no
  // separate verification step — and stamps factorRequiredAt (OS-494) in the
  // same UPDATE, so there is no window in which a joined staff member exists
  // without the factor requirement.
  //
  // Undefined for a User who is gone or deactivated, and the caller answers
  // both the way it answers an Invite it doesn't recognise. Deactivation is
  // part of the WHERE rather than a read of its own so that "is this person
  // still allowed to join" and "join them" cannot come apart; the row is
  // locked by the redemption either way. The caller throws on undefined,
  // which rolls the claim back — so a deactivated invitee's Invite survives
  // for a later reactivation.
  async activate(
    id: number,
    hashedPassword: string,
    tx: DbTransaction,
  ): Promise<User | undefined> {
    const [user] = await tx
      .update(usersTable)
      .set({
        password: hashedPassword,
        emailVerifiedAt: new Date(),
        factorRequiredAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(usersTable.id, id), isNull(usersTable.deactivatedAt)))
      .returning();

    if (!user) return undefined;

    const roles = await this.getRolesByUserId([user.id], tx);
    return toUser(user, roles.get(user.id) ?? []);
  }

  // no password is set here — the account owner invites a staff member and
  // they join later via the emailed invite link, at which point they set
  // their own. The Staff record and its Invite are written in one
  // transaction so a failure partway through never leaves a user with no way
  // to ever join — which is what the tx handed to issue() is for. roleIds
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
      const { user, secret } = await this.db.transaction(async (tx) => {
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

        const secret = await this.emailedLinks.issue('invite', user.id, tx);

        return { user, secret };
      });

      const inviteUrl = `${env.MERCHANT_WEB_URL}/join?token=${secret}`;
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
    // Present-but-blank is a clear, not a no-op: phone is the one nullable
    // field here, and a user who deletes the contents of the box means to
    // remove the number. Absent (undefined) still leaves the column alone.
    // What's stored is the trimmed value — the same one the blank test looks
    // at — so a direct API caller can't persist the padding the forms strip.
    if (dto.phone !== undefined) {
      patch.phone = dto.phone?.trim() || null;
    }

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

  // The caller's own Profile (ADR 0001), behind GET /auth/me/profile.
  //
  // accountId is still part of the lookup even though userId comes from the
  // caller's own access token, because every other read in this service is
  // account-scoped and a self-read that quietly wasn't would be the one place
  // a token minted before a user moved accounts could read across tenants.
  //
  // Goes through getById rather than its own SELECT so that "what a Profile
  // is" has exactly one definition; the extra roles lookup it costs is the
  // price of not maintaining a second projection of the same row.
  async getProfile(
    userId: number,
    accountId: number,
  ): Promise<UserProfile | undefined> {
    const user = await this.getById(userId, accountId);
    return user && toProfile(user);
  }

  // The write half, behind PATCH /auth/me/profile. Delegates to update() —
  // the administrative PATCH /users/:id path — so the self-service and
  // administrative writes can't develop different ideas about which columns
  // are editable or how an empty patch behaves.
  async updateProfile(
    userId: number,
    accountId: number,
    dto: UpdateUserProfileDto,
  ): Promise<UserProfile | undefined> {
    const user = await this.update(userId, accountId, dto);
    return user && toProfile(user);
  }

  // deactivate (set deactivatedAt) / reactivate (clear it). Deactivating the
  // last non-deactivated holder of an isSystem (Owner) role is refused —
  // reuses the same Owner-role row lock as updateRoles so concurrent
  // deactivations serialize through one point and can't both slip past the
  // "is there another Owner?" check. Reactivating is always allowed.
  //
  // Deactivating also ends every Session the User holds, in the same
  // transaction: without it their refresh-token rows stay live and only the
  // claim check at the next refresh turns them away — and that check passes
  // again the moment they're reactivated, handing back Sessions that predate
  // the deactivation. In the transaction rather than after it because a
  // revoke that failed after the commit could never be retried — the second
  // attempt returns early below, the User being deactivated already.
  // Reactivating touches no Session: the User signs in again. An access token
  // already issued still outlives this by up to its TTL (nothing re-checks
  // the row per request).
  //
  // And it withdraws their outstanding password-reset and email-verification
  // links, for the same reason and in the same transaction: a reset link
  // requested ten minutes before the deactivation otherwise still sets a new
  // password on their row, and that password survives into a later
  // reactivation. "Deactivated" should leave nothing of theirs that still
  // works. A pending Invite is deliberately left alone — there is no
  // credential to protect yet, and reactivating someone switched off by
  // mistake shouldn't force a re-invite; an Owner has revokeInvite for when
  // they do want it gone.
  //
  // The lock order is unchanged and load-bearing. The User row is written
  // first, and it is the row everything after it wants: the Session sweep
  // takes it FOR UPDATE, and so does every Emailed links operation. A
  // concurrent redemption of one of these links therefore queues behind this
  // transaction (or it behind that one) rather than the two taking the User
  // row and a link row in opposite orders and Postgres aborting one as a
  // deadlock victim.
  //
  // Refusing the last-Owner deactivation happens before any of this, inside
  // the transaction, so a refusal withdraws nothing: the throw rolls back the
  // whole thing.
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

      if (deactivated && updated) {
        await this.sessionsService.revokeAll(userId, tx);
        await this.emailedLinks.revokeAllForSubject(
          userId,
          ['passwordReset', 'emailVerification'],
          tx,
        );
      }
    });

    if (!updated) return undefined;

    const roles = await this.getRolesByUserId([updated.id]);
    return toUser(updated, roles.get(updated.id) ?? []);
  }

  // Sends this account's pending staff member a fresh Invite, which kills
  // the one in the earlier email — issuing replaces. Returns undefined when
  // the id doesn't name a User of this account, or when they've already
  // joined, which is the whole precondition: a Staff record with no password
  // is what "still invited" means.
  //
  // It used to be undefined for a pending User with no invite row too, and
  // that fourth answer is gone deliberately (OS-530). Two module rules
  // between them forbid it: an Emailed link has no non-consuming peek, and
  // no code outside the module reads the link tables. Asking "is there an
  // Invite row?" before issuing a replacement is exactly that peek, and
  // there is no version of it this service is allowed to make.
  //
  // Nothing is lost. The state is unreachable — create() writes the Invite
  // in the same transaction as the Staff record, and accepting one sets the
  // password, which this method's own precondition already excludes — and
  // if it ever were reachable, answering "not found" rather than sending
  // the link the Owner asked for would be the wrong answer anyway, since
  // issuing replaces whether or not a row is there. No caller depends on
  // the old behaviour either: UsersController still turns undefined into a
  // 404 for a wrong-account id or an already-joined User, and merchant-web
  // only raises a toast from it.
  async resendInvite(
    userId: number,
    accountId: number,
  ): Promise<User | undefined> {
    const [user] = await this.db
      .select()
      .from(usersTable)
      .where(
        and(eq(usersTable.id, userId), eq(usersTable.accountId, accountId)),
      );

    if (!user || user.password) return undefined;

    const secret = await this.emailedLinks.issue('invite', userId);

    const inviteUrl = `${env.MERCHANT_WEB_URL}/join?token=${secret}`;
    await this.emailService.sendInviteEmail(user.email, {
      firstName: user.firstname,
      inviteUrl,
    });

    const roles = await this.getRolesByUserId([user.id]);
    return toUser(user, roles.get(user.id) ?? []);
  }

  // hard-deletes a never-joined invitee (user row + invite, which cascades).
  // Only valid while password IS NULL — a joined user must be deactivated
  // instead (see OS-184), so their row + history survive. Returns the
  // now-deleted user's shape (for the caller's response) or undefined when
  // the id doesn't match a user in this account; throws ConflictException
  // when it does but they've already joined.
  async revokeInvite(
    userId: number,
    accountId: number,
  ): Promise<User | undefined> {
    const [user] = await this.db
      .select()
      .from(usersTable)
      .where(
        and(eq(usersTable.id, userId), eq(usersTable.accountId, accountId)),
      );

    if (!user) return undefined;

    if (user.password) {
      throw new ConflictException(
        'This user has already joined — deactivate them instead',
      );
    }

    const roles = await this.getRolesByUserId([user.id]);

    // The Invite is withdrawn through the module rather than left to the
    // user_invites row's ON DELETE CASCADE: an Invite stops working because
    // something revoked it, not as a side effect of a foreign key, and this
    // is the operation that serializes with a redemption already in flight
    // (it takes the User's row first, like every other Emailed link
    // operation). One transaction, so a revoke that failed after the link
    // was withdrawn can't leave a Staff record nobody can join and nobody
    // can re-invite.
    await this.db.transaction(async (tx) => {
      await this.emailedLinks.revokeAllForSubject(userId, ['invite'], tx);
      await tx.delete(usersTable).where(eq(usersTable.id, userId));
    });
    return toUser(user, roles.get(user.id) ?? []);
  }

  // batched: one query for every user's roles instead of one per user.
  // Takes an optional transaction so a caller that is mid-write (activate,
  // inside the Invite's redemption) reads through it rather than opening a
  // second connection that would see the row as it was before.
  private async getRolesByUserId(userIds: number[], tx?: DbTransaction) {
    if (userIds.length === 0) return new Map<number, UserRoleSummary[]>();

    const rows = await (tx ?? this.db)
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
