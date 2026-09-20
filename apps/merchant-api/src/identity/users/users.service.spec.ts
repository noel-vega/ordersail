import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import {
  assignRole,
  insertAccount,
  insertRole,
  insertUser,
  insertUserInvite,
  seedPermissionsCatalog,
  useTestDb,
} from 'test-support';
import { eq, userInvitesTable, usersTable } from 'db/identity';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { EmailService } from 'src/shared/email/email.service';
import { PermissionsService } from '../permissions/permissions.service';
import { UsersService } from './users.service';
import { hashToken } from 'src/shared/common/generate-token.util';

const db = useTestDb();

const emailMock = { sendInviteEmail: jest.fn() };
beforeEach(() => emailMock.sendInviteEmail.mockClear());

async function build() {
  const ref = await Test.createTestingModule({
    providers: [
      UsersService,
      { provide: DRIZZLE, useValue: db },
      { provide: EmailService, useValue: emailMock },
      { provide: PermissionsService, useValue: {} },
    ],
  }).compile();
  return ref.get(UsersService);
}

describe('UsersService.findAll (OS-160)', () => {
  it('paginates and reports the account-wide total', async () => {
    const account = await insertAccount(db);
    for (let i = 0; i < 25; i++) {
      await insertUser(db, { accountId: account.id });
    }
    const service = await build();

    const first = await service.findAll(10, 0, account.id);
    expect(first.items).toHaveLength(10);
    expect(first).toMatchObject({ total: 25, limit: 10, offset: 0 });
    expect(first.items[0]?.roles).toEqual([]);

    const third = await service.findAll(10, 20, account.id);
    expect(third.items).toHaveLength(5);
  });

  it('clamps limit to 100 and floors a negative offset', async () => {
    const account = await insertAccount(db);
    await insertUser(db, { accountId: account.id });
    const service = await build();

    const page = await service.findAll(999, -5, account.id);
    expect(page).toMatchObject({ limit: 100, offset: 0 });
  });

  it('filters by q on first name, last name or email, case-insensitive', async () => {
    const account = await insertAccount(db);
    await insertUser(db, {
      accountId: account.id,
      firstname: 'Walter',
      lastname: 'Skinner',
      email: 'walter@fbi.test',
    });
    await insertUser(db, {
      accountId: account.id,
      firstname: 'Dana',
      lastname: 'Scully',
      email: 'dana@fbi.test',
    });
    const service = await build();

    expect((await service.findAll(20, 0, account.id, 'skinner')).total).toBe(1);
    expect((await service.findAll(20, 0, account.id, 'DANA')).total).toBe(1);
    expect((await service.findAll(20, 0, account.id, 'fbi.test')).total).toBe(
      2,
    );
    expect((await service.findAll(20, 0, account.id, 'nobody')).total).toBe(0);
  });

  it('is scoped to the account', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    await insertUser(db, { accountId: a.id });
    await insertUser(db, { accountId: b.id });
    const service = await build();

    const page = await service.findAll(20, 0, a.id);
    expect(page.total).toBe(1);
    expect(page.items[0]?.accountId).toBe(a.id);
  });

  it('still lists deactivated members, badged (OS-184)', async () => {
    const account = await insertAccount(db);
    await insertUser(db, { accountId: account.id, password: 'x' });
    await insertUser(db, {
      accountId: account.id,
      password: 'x',
      deactivatedAt: new Date(),
    });
    const service = await build();

    const page = await service.findAll(20, 0, account.id);
    expect(page.total).toBe(2);
    expect(page.items.map((u) => u.status).sort()).toEqual([
      'active',
      'deactivated',
    ]);
  });
});

describe('UsersService status derivation (OS-184)', () => {
  it('maps password / no-password / deactivatedAt to a status', async () => {
    const account = await insertAccount(db);
    const invited = await insertUser(db, { accountId: account.id });
    const active = await insertUser(db, {
      accountId: account.id,
      password: 'hashed',
    });
    const gone = await insertUser(db, {
      accountId: account.id,
      password: 'hashed',
      deactivatedAt: new Date(),
    });
    const service = await build();

    expect((await service.getById(invited.id, account.id))?.status).toBe(
      'invited',
    );
    expect((await service.getById(active.id, account.id))?.status).toBe(
      'active',
    );
    expect((await service.getById(gone.id, account.id))?.status).toBe(
      'deactivated',
    );
  });
});

describe('UsersService.getById (OS-184)', () => {
  it('returns the member with roles, scoped to the account', async () => {
    const account = await insertAccount(db);
    const other = await insertAccount(db);
    await seedPermissionsCatalog(db);
    const user = await insertUser(db, {
      accountId: account.id,
      firstname: 'Fox',
      lastname: 'Mulder',
    });
    const role = await insertRole(db, {
      accountId: account.id,
      name: 'Support',
      permissionKeys: ['orders:read'],
    });
    await assignRole(db, { userId: user.id, roleId: role.id });
    const service = await build();

    const found = await service.getById(user.id, account.id);
    expect(found).toMatchObject({ firstName: 'Fox', lastName: 'Mulder' });
    expect(found?.roles).toEqual([{ id: role.id, name: 'Support' }]);

    expect(await service.getById(user.id, other.id)).toBeUndefined();
  });
});

describe('UsersService.update (OS-184)', () => {
  it('updates name and phone but never email', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, {
      accountId: account.id,
      email: 'keep@store.test',
    });
    const service = await build();

    const updated = await service.update(user.id, account.id, {
      firstName: 'New',
      phone: '5555559999',
    });
    expect(updated).toMatchObject({
      firstName: 'New',
      phone: '5555559999',
      email: 'keep@store.test',
    });
  });

  // OS-503 story 4: blanking the phone box has to actually remove the
  // number. The three states of the field are distinct and all three are
  // asserted, because the bug was exactly the collapse of two of them —
  // "cleared" arrived as "absent" and silently did nothing.
  it('clears the phone when an explicit null is patched', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, {
      accountId: account.id,
      phone: '5555559999',
    });
    const service = await build();

    const updated = await service.update(user.id, account.id, { phone: null });
    expect(updated?.phone).toBeNull();
  });

  it('clears the phone when a blank string is patched', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, {
      accountId: account.id,
      phone: '5555559999',
    });
    const service = await build();

    expect(
      (await service.update(user.id, account.id, { phone: '' }))?.phone,
    ).toBeNull();
    // whitespace is the same intent typed less carefully
    await service.update(user.id, account.id, { phone: '5555559999' });
    expect(
      (await service.update(user.id, account.id, { phone: '   ' }))?.phone,
    ).toBeNull();
  });

  it('stores the phone trimmed', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, { accountId: account.id });
    const service = await build();

    // the forms trim before sending; a direct API caller doesn't have to
    const updated = await service.update(user.id, account.id, {
      phone: '  5555559999  ',
    });
    expect(updated?.phone).toBe('5555559999');
  });

  it('leaves the phone alone when the field is absent', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, {
      accountId: account.id,
      phone: '5555559999',
    });
    const service = await build();

    const updated = await service.update(user.id, account.id, {
      firstName: 'Dana',
    });
    expect(updated?.phone).toBe('5555559999');
  });

  it('an empty patch is a no-op read', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, { accountId: account.id });
    const service = await build();

    const updated = await service.update(user.id, account.id, {});
    expect(updated?.id).toBe(user.id);
  });

  it('is undefined for a user outside the account', async () => {
    const account = await insertAccount(db);
    const other = await insertAccount(db);
    const user = await insertUser(db, { accountId: account.id });
    const service = await build();

    expect(
      await service.update(user.id, other.id, { firstName: 'x' }),
    ).toBeUndefined();
  });
});

// OS-384 — the Profile aspect (ADR 0001). The point of these two is the
// narrowing: a caller reading their own Profile holds no users:read, so the
// roles, status and account the Staff record carries must not come back with
// it, and the account scoping has to hold even though the id came from the
// caller's own token.
describe('UsersService profile (OS-384)', () => {
  it('returns only the self-editable fields, not the staff record', async () => {
    const account = await insertAccount(db);
    await seedPermissionsCatalog(db);
    const user = await insertUser(db, {
      accountId: account.id,
      firstname: 'Fox',
      lastname: 'Mulder',
      phone: '5555550199',
    });
    const role = await insertRole(db, {
      accountId: account.id,
      name: 'Support',
      permissionKeys: ['orders:read'],
    });
    await assignRole(db, { userId: user.id, roleId: role.id });
    const service = await build();

    expect(await service.getProfile(user.id, account.id)).toEqual({
      firstName: 'Fox',
      lastName: 'Mulder',
      phone: '5555550199',
    });
  });

  it('updates name and phone and returns the new Profile', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, {
      accountId: account.id,
      email: 'keep@store.test',
    });
    const service = await build();

    expect(
      await service.updateProfile(user.id, account.id, {
        firstName: 'Katherine',
        phone: '5555559999',
      }),
    ).toMatchObject({ firstName: 'Katherine', phone: '5555559999' });

    // the email column is untouched — it's the sign-in identity, and the DTO
    // has no field for it
    const [row] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, user.id));
    expect(row?.email).toBe('keep@store.test');
  });

  it('is undefined for a user outside the account', async () => {
    const account = await insertAccount(db);
    const other = await insertAccount(db);
    const user = await insertUser(db, { accountId: account.id });
    const service = await build();

    expect(await service.getProfile(user.id, other.id)).toBeUndefined();
    expect(
      await service.updateProfile(user.id, other.id, { firstName: 'x' }),
    ).toBeUndefined();
  });
});

describe('UsersService.setDeactivated (OS-184)', () => {
  it('deactivates then reactivates a member', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, {
      accountId: account.id,
      password: 'x',
    });
    const service = await build();

    const off = await service.setDeactivated(user.id, account.id, true);
    expect(off?.status).toBe('deactivated');

    const on = await service.setDeactivated(user.id, account.id, false);
    expect(on?.status).toBe('active');
  });

  it('refuses to deactivate the last active Owner-role holder', async () => {
    const account = await insertAccount(db);
    await seedPermissionsCatalog(db);
    const owner = await insertRole(db, {
      accountId: account.id,
      name: 'Owner',
      isSystem: true,
    });
    const user = await insertUser(db, {
      accountId: account.id,
      password: 'x',
    });
    await assignRole(db, { userId: user.id, roleId: owner.id });
    const service = await build();

    await expect(
      service.setDeactivated(user.id, account.id, true),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows deactivating an Owner when another active Owner remains', async () => {
    const account = await insertAccount(db);
    await seedPermissionsCatalog(db);
    const owner = await insertRole(db, {
      accountId: account.id,
      name: 'Owner',
      isSystem: true,
    });
    const a = await insertUser(db, { accountId: account.id, password: 'x' });
    const b = await insertUser(db, { accountId: account.id, password: 'x' });
    await assignRole(db, { userId: a.id, roleId: owner.id });
    await assignRole(db, { userId: b.id, roleId: owner.id });
    const service = await build();

    const off = await service.setDeactivated(a.id, account.id, true);
    expect(off?.status).toBe('deactivated');
  });

  it('is undefined for a user outside the account', async () => {
    const account = await insertAccount(db);
    const other = await insertAccount(db);
    const user = await insertUser(db, { accountId: account.id });
    const service = await build();

    expect(
      await service.setDeactivated(user.id, other.id, true),
    ).toBeUndefined();
  });
});

describe('UsersService.getByEmail (OS-184)', () => {
  it('excludes a deactivated user so sign-in is refused', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, {
      accountId: account.id,
      email: 'gone@store.test',
      password: 'x',
      deactivatedAt: new Date(),
    });
    const service = await build();

    expect(await service.getByEmail('gone@store.test')).toBeUndefined();

    await service.setDeactivated(user.id, account.id, false);
    expect((await service.getByEmail('gone@store.test'))?.id).toBe(user.id);
  });
});

describe('UsersService.resendInvite (OS-185)', () => {
  it('rotates the token + expiry and re-sends the email', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, { accountId: account.id });
    const invite = await insertUserInvite(db, {
      userId: user.id,
      token: 'old-token',
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(typeof invite.id).toBe('number');
    expect(invite.userId).toBe(user.id);
    expect(invite.token).toBe('old-token');
    const service = await build();

    const result = await service.resendInvite(user.id, account.id);
    expect(result?.status).toBe('invited');

    const [fresh] = await db
      .select()
      .from(userInvitesTable)
      .where(eq(userInvitesTable.userId, user.id));
    expect(fresh.token).not.toBe(hashToken('old-token'));
    expect(fresh.token).not.toBe(hashToken(invite.token));
    expect(fresh.expiresAt.getTime()).toBeGreaterThan(Date.now());

    expect(emailMock.sendInviteEmail).toHaveBeenCalledTimes(1);
    const [to, params] = emailMock.sendInviteEmail.mock.calls[0] as [
      string,
      { firstName: string; inviteUrl: string },
    ];
    expect(to).toBe(user.email);
    // OS-476: the link carries the raw token, the row only its digest
    const emailed = new URL(params.inviteUrl).searchParams.get('token')!;
    expect(fresh.token).not.toBe(emailed);
    expect(fresh.token).toBe(hashToken(emailed));
  });

  it('is undefined for a user who has already joined', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, {
      accountId: account.id,
      password: 'x',
    });
    const service = await build();

    expect(await service.resendInvite(user.id, account.id)).toBeUndefined();
    expect(emailMock.sendInviteEmail).not.toHaveBeenCalled();
  });

  it('is undefined for a user with no pending invite row', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, { accountId: account.id });
    const service = await build();

    expect(await service.resendInvite(user.id, account.id)).toBeUndefined();
  });

  it('is undefined for a user outside the account', async () => {
    const account = await insertAccount(db);
    const other = await insertAccount(db);
    const user = await insertUser(db, { accountId: account.id });
    await insertUserInvite(db, { userId: user.id });
    const service = await build();

    expect(await service.resendInvite(user.id, other.id)).toBeUndefined();
  });
});

describe('UsersService.revokeInvite (OS-185)', () => {
  it('deletes the never-joined user and their invite', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, { accountId: account.id });
    await insertUserInvite(db, { userId: user.id });
    const service = await build();

    expect((await service.revokeInvite(user.id, account.id))?.status).toBe(
      'invited',
    );

    const users = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, user.id));
    expect(users).toHaveLength(0);
    const invites = await db
      .select()
      .from(userInvitesTable)
      .where(eq(userInvitesTable.userId, user.id));
    expect(invites).toHaveLength(0);
  });

  it('refuses to revoke a user who has already joined', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, {
      accountId: account.id,
      password: 'x',
    });
    const service = await build();

    await expect(
      service.revokeInvite(user.id, account.id),
    ).rejects.toBeInstanceOf(ConflictException);

    const users = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, user.id));
    expect(users).toHaveLength(1);
  });

  it('is undefined for a user outside the account', async () => {
    const account = await insertAccount(db);
    const other = await insertAccount(db);
    const user = await insertUser(db, { accountId: account.id });
    await insertUserInvite(db, { userId: user.id });
    const service = await build();

    expect(await service.revokeInvite(user.id, other.id)).toBeUndefined();
  });
});
