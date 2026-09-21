import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import {
  assignRole,
  firstnameOf,
  insertAccount,
  insertRole,
  insertUser,
  liveRefreshTokenCount,
  lockWaiters,
  raceForUserRow,
  seedPermissionsCatalog,
  useTestDb,
} from 'test-support';
import { eq, userRefreshTokensTable, usersTable } from 'db/identity';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { EmailService } from 'src/shared/email/email.service';
import { PermissionsService } from '../permissions/permissions.service';
import { FactorStateService } from '../auth/factor-state.service';
import { SessionsService } from '../auth/sessions.service';
import {
  expectWorkingSession,
  raceForRefreshRow,
  testJwt,
} from '../auth/sessions.spec-support';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { EmailedLinksService } from '../emailed-links/emailed-links.service';
import {
  emailedLinkSecret,
  outstandingLinkCount,
  renameTo,
} from '../emailed-links/emailed-links.spec-support';

const db = useTestDb();

const emailMock = { sendInviteEmail: jest.fn() };
beforeEach(() => emailMock.sendInviteEmail.mockClear());

// Sessions is real here, signing with a real JwtService: deactivation's
// effect on a User's Sessions is only observable by redeeming their tokens.
// Emailed links is real for the same reason — an Invite is one, and what a
// deactivation does to a User's outstanding links, or a resend to the link
// in the earlier email, is only observable by presenting one.
async function buildBoth() {
  const ref = await Test.createTestingModule({
    providers: [
      UsersService,
      SessionsService,
      FactorStateService,
      EmailedLinksService,
      { provide: DRIZZLE, useValue: db },
      { provide: EmailService, useValue: emailMock },
      { provide: PermissionsService, useValue: {} },
      { provide: JwtService, useValue: testJwt() },
    ],
  }).compile();
  return {
    service: ref.get(UsersService),
    sessions: ref.get(SessionsService),
    links: ref.get(EmailedLinksService),
  };
}

// Whether the link in an invite email is still live, asked the way the
// invitee's browser asks it — by presenting it. The effect is a no-op:
// what joining actually does to the Staff record is acceptInvite's, in
// auth.service.spec.
async function inviteIsLive(
  links: EmailedLinksService,
  secret: string,
): Promise<boolean> {
  const outcome = await links.redeem('invite', secret, () =>
    Promise.resolve(true),
  );
  return outcome.redeemed;
}

// The secret out of the invite email this spec's flow just sent.
function emailedInviteSecret(call = 0): string {
  return emailedLinkSecret(
    emailMock.sendInviteEmail,
    (params: { inviteUrl: string }) => params.inviteUrl,
    call,
  );
}

async function build() {
  return (await buildBoth()).service;
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

describe('UsersService.setDeactivated ends Sessions (OS-553)', () => {
  it("revokes every one of the User's Sessions, and nobody else's", async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, { accountId: account.id, password: 'x' });
    const colleague = await insertUser(db, {
      accountId: account.id,
      password: 'x',
    });
    const { service, sessions } = await buildBoth();
    const laptop = await sessions.start(user.id);
    const phone = await sessions.start(user.id);
    const theirs = await sessions.start(colleague.id);

    await service.setDeactivated(user.id, account.id, true);

    // The rows themselves are dead — "deactivated" is true in the database,
    // not merely discovered by the claim check at the next refresh.
    expect(await liveRefreshTokenCount(db, user.id)).toBe(0);
    await expect(
      sessions.refreshTokens(laptop.refresh_token),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      sessions.refreshTokens(phone.refresh_token),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    await expectWorkingSession(sessions, theirs, colleague.id);
  });

  it('leaves the old Sessions dead on reactivation; a new sign-in works', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, { accountId: account.id, password: 'x' });
    const { service, sessions } = await buildBoth();
    const laptop = await sessions.start(user.id);
    const phone = await sessions.start(user.id);

    await service.setDeactivated(user.id, account.id, true);
    await service.setDeactivated(user.id, account.id, false);

    // Active again, so the claim check would pass — only the revoked rows
    // stand between these tokens and a Session.
    await expect(
      sessions.refreshTokens(laptop.refresh_token),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      sessions.refreshTokens(phone.refresh_token),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await liveRefreshTokenCount(db, user.id)).toBe(0);

    await expectWorkingSession(
      sessions,
      await sessions.start(user.id),
      user.id,
    );
  });

  // merchant-web refreshes on every navigation, so a deactivation can land
  // while the User's refresh has inserted a successor it hasn't committed
  // yet. That refresh was let in before the deactivation, so it is answered
  // — but the token it is answered with must die with the rest. Left live,
  // it is refused only while the User stays deactivated, and works again the
  // moment they are reactivated: a Session that predates the deactivation,
  // handed back. The refresh is parked first, so it is the one in flight.
  it('ends a Session whose refresh was already in flight, and reactivating resurrects nothing', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, { accountId: account.id, password: 'x' });
    const { service, sessions } = await buildBoth();
    const laptop = await sessions.start(user.id);

    const [refreshed] = await raceForRefreshRow(
      db,
      laptop.refresh_token,
      2,
      async () => {
        const refreshing = sessions.refreshTokens(laptop.refresh_token);
        refreshing.catch(() => undefined);
        await lockWaiters(db, 1);
        return Promise.all([
          refreshing,
          service.setDeactivated(user.id, account.id, true),
        ]);
      },
    );

    expect(await liveRefreshTokenCount(db, user.id)).toBe(0);

    await service.setDeactivated(user.id, account.id, false);

    await expect(
      sessions.refreshTokens(refreshed.refresh_token),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await liveRefreshTokenCount(db, user.id)).toBe(0);
  });

  // The other order: the deactivation holds the User row first, and the
  // refresh — which computed its claims while the User was still active — is
  // let through only once "deactivated" has committed. It must be refused
  // there, having written nothing.
  it('refuses a refresh let through only after the deactivation committed, and writes nothing', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, { accountId: account.id, password: 'x' });
    const { service, sessions } = await buildBoth();
    const laptop = await sessions.start(user.id);

    const [, refreshing] = await raceForRefreshRow(
      db,
      laptop.refresh_token,
      2,
      async () => {
        const deactivating = service.setDeactivated(user.id, account.id, true);
        deactivating.catch(() => undefined);
        await lockWaiters(db, 1);
        return Promise.all([
          deactivating,
          sessions.refreshTokens(laptop.refresh_token).then(
            () => 'continued' as const,
            (err: unknown) => err,
          ),
        ]);
      },
    );

    expect(refreshing).toBeInstanceOf(UnauthorizedException);
    expect(await db.select().from(userRefreshTokensTable)).toHaveLength(1);

    await service.setDeactivated(user.id, account.id, false);
    expect(await liveRefreshTokenCount(db, user.id)).toBe(0);
  });

  it('ends no Sessions when the last-Owner guard refuses the deactivation', async () => {
    const account = await insertAccount(db);
    await seedPermissionsCatalog(db);
    const owner = await insertRole(db, {
      accountId: account.id,
      name: 'Owner',
      isSystem: true,
    });
    const user = await insertUser(db, { accountId: account.id, password: 'x' });
    await assignRole(db, { userId: user.id, roleId: owner.id });
    const { service, sessions } = await buildBoth();
    const pair = await sessions.start(user.id);

    await expect(
      service.setDeactivated(user.id, account.id, true),
    ).rejects.toBeInstanceOf(ConflictException);

    await expectWorkingSession(sessions, pair, user.id);
  });
});

describe('UsersService.setDeactivated withdraws Emailed links (OS-559)', () => {
  it('leaves no working reset or verification link, and reactivating brings neither back', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, { accountId: account.id, password: 'x' });
    const { service, links } = await buildBoth();
    const reset = await links.issue('passwordReset', user.id);
    const verification = await links.issue('emailVerification', user.id);

    await service.setDeactivated(user.id, account.id, true);

    expect(
      await links.redeem('passwordReset', reset, renameTo('Reset')),
    ).toEqual({ redeemed: false });
    expect(
      await links.redeem(
        'emailVerification',
        verification,
        renameTo('Verified'),
      ),
    ).toEqual({ redeemed: false });

    // Not merely refused while they're switched off: the links are gone, so
    // a reactivation can't hand back a password chosen from an email sent
    // before the deactivation.
    await service.setDeactivated(user.id, account.id, false);

    expect(
      await links.redeem('passwordReset', reset, renameTo('Reset')),
    ).toEqual({ redeemed: false });
    expect(
      await links.redeem(
        'emailVerification',
        verification,
        renameTo('Verified'),
      ),
    ).toEqual({ redeemed: false });
  });

  // Deliberate: there is no credential to protect on a User who has never
  // set one, and an Owner who switched someone off by mistake shouldn't
  // have to re-invite them. Making an Invite go away is revokeInvite's job.
  it('leaves a pending Invite alone — it still works after a reactivation', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, { accountId: account.id });
    const { service, links } = await buildBoth();
    const invite = await links.issue('invite', user.id);

    await service.setDeactivated(user.id, account.id, true);
    await service.setDeactivated(user.id, account.id, false);

    expect(await links.redeem('invite', invite, renameTo('Joined'))).toEqual({
      redeemed: true,
      result: user.id,
    });
  });

  it("leaves a colleague's links of the same kinds alone", async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, { accountId: account.id, password: 'x' });
    const colleague = await insertUser(db, {
      accountId: account.id,
      password: 'x',
    });
    const { service, links } = await buildBoth();
    const theirs = await links.issue('passwordReset', colleague.id);

    await service.setDeactivated(user.id, account.id, true);

    expect(
      await links.redeem('passwordReset', theirs, renameTo('Theirs')),
    ).toEqual({ redeemed: true, result: colleague.id });
  });

  it('withdraws nothing when the last-Owner guard refuses the deactivation', async () => {
    const account = await insertAccount(db);
    await seedPermissionsCatalog(db);
    const owner = await insertRole(db, {
      accountId: account.id,
      name: 'Owner',
      isSystem: true,
    });
    const user = await insertUser(db, { accountId: account.id, password: 'x' });
    await assignRole(db, { userId: user.id, roleId: owner.id });
    const { service, links } = await buildBoth();
    const reset = await links.issue('passwordReset', user.id);

    await expect(
      service.setDeactivated(user.id, account.id, true),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(
      await links.redeem('passwordReset', reset, renameTo('Still')),
    ).toEqual({ redeemed: true, result: user.id });
  });

  // The cycle this ticket closes. Until now a deactivation touched no link
  // table, so however either side was written the two could not deadlock;
  // now both transactions want the User's row and rows that hang off it,
  // and the only thing keeping Postgres from aborting one of them as a
  // deadlock victim is that both take the User's row first. Staged on that
  // row so it is a race on every run rather than when the scheduler
  // obliges, in both orders because which of the two arrives first is not
  // ours to choose.
  it('lets a redemption already in flight finish, then withdraws what is left', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, { accountId: account.id, password: 'x' });
    const { service, links } = await buildBoth();
    const reset = await links.issue('passwordReset', user.id);
    const verification = await links.issue('emailVerification', user.id);

    const [outcome] = await raceForUserRow(db, user.id, 2, async () => {
      const redeeming = links.redeem(
        'passwordReset',
        reset,
        renameTo('Redeemed'),
      );
      redeeming.catch(() => undefined);
      await lockWaiters(db, 1);
      return Promise.all([
        redeeming,
        service.setDeactivated(user.id, account.id, true),
      ]);
    });

    // Both transactions completed. The redemption queued first, so it was
    // let in and did its job; the deactivation behind it found that link
    // already used up and took the other one with it.
    expect(outcome).toEqual({ redeemed: true, result: user.id });
    expect(await firstnameOf(db, user.id)).toBe('Redeemed');
    expect(await outstandingLinkCount(db, 'passwordReset', user.id)).toBe(0);
    expect(
      await links.redeem('emailVerification', verification, renameTo('Late')),
    ).toEqual({ redeemed: false });
  });

  // The other order: the deactivation holds the User's row first, so the
  // redemption — which read a live link row before parking — is let through
  // only once the withdrawal has committed. It must find nothing to claim
  // and write nothing, rather than act on the row it read.
  it('refuses a redemption let through only after the deactivation committed', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, { accountId: account.id, password: 'x' });
    const { service, links } = await buildBoth();
    const reset = await links.issue('passwordReset', user.id);
    const before = await firstnameOf(db, user.id);

    const [, outcome] = await raceForUserRow(db, user.id, 2, async () => {
      const deactivating = service.setDeactivated(user.id, account.id, true);
      deactivating.catch(() => undefined);
      await lockWaiters(db, 1);
      return Promise.all([
        deactivating,
        links.redeem('passwordReset', reset, renameTo('Redeemed')),
      ]);
    });

    expect(outcome).toEqual({ redeemed: false });
    expect(await firstnameOf(db, user.id)).toBe(before);
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

describe('UsersService.create — the pending Staff record and its Invite', () => {
  it('emails the new staff member a link that is live', async () => {
    const account = await insertAccount(db);
    const { service, links } = await buildBoth();

    const created = await service.create(
      new CreateUserDto('Fox', 'Mulder', '5555550111', 'fox@store.test'),
      account.id,
      1,
    );

    expect(created.status).toBe('invited');
    expect(emailMock.sendInviteEmail).toHaveBeenCalledWith(
      'fox@store.test',
      expect.objectContaining({ firstName: 'Fox' }),
    );
    expect(await inviteIsLive(links, emailedInviteSecret())).toBe(true);
  });

  // The Staff record and its Invite are one write: a create that fails
  // after the User row would otherwise leave someone who can never join and
  // can't be re-invited (resendInvite needs the account's own id).
  it('leaves no Staff record behind when the create rolls back', async () => {
    const account = await insertAccount(db);
    const { service } = await buildBoth();

    await expect(
      service.create(
        new CreateUserDto(
          'Dana',
          'Scully',
          '5555550112',
          'dana@store.test',
          [404],
        ),
        account.id,
        1,
        new Set(['users:manage_roles']),
      ),
    ).rejects.toThrow();

    expect((await service.findAll(20, 0, account.id)).total).toBe(0);
    expect(emailMock.sendInviteEmail).not.toHaveBeenCalled();
  });
});

// Only the newest email works, and only while the Staff record is still
// pending. How long an Invite lasts, and that presenting a dead one is
// refused, are the Emailed links module's (emailed-links.service.spec).
describe('UsersService.resendInvite (OS-185)', () => {
  it('emails a working link and kills the one from the earlier email', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, { accountId: account.id });
    const { service, links } = await buildBoth();
    const first = await links.issue('invite', user.id);

    const result = await service.resendInvite(user.id, account.id);
    expect(result?.status).toBe('invited');

    expect(emailMock.sendInviteEmail).toHaveBeenCalledWith(
      user.email,
      expect.objectContaining({ firstName: user.firstname }),
    );
    expect(await inviteIsLive(links, first)).toBe(false);
    expect(await inviteIsLive(links, emailedInviteSecret())).toBe(true);
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

  // Unreachable in practice — a pending Staff record always has an Invite,
  // because create() writes them together — but the answer to "resend" is
  // a working link either way, never a 404.
  it('issues one for a pending user who somehow holds none', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, { accountId: account.id });
    const { service, links } = await buildBoth();

    expect((await service.resendInvite(user.id, account.id))?.status).toBe(
      'invited',
    );

    expect(await inviteIsLive(links, emailedInviteSecret())).toBe(true);
  });

  it('is undefined for a user outside the account', async () => {
    const account = await insertAccount(db);
    const other = await insertAccount(db);
    const user = await insertUser(db, { accountId: account.id });
    const { service, links } = await buildBoth();
    const invite = await links.issue('invite', user.id);

    expect(await service.resendInvite(user.id, other.id)).toBeUndefined();
    expect(emailMock.sendInviteEmail).not.toHaveBeenCalled();
    expect(await inviteIsLive(links, invite)).toBe(true);
  });
});

describe('UsersService.revokeInvite (OS-185)', () => {
  it('deletes the never-joined user and kills their link immediately', async () => {
    const account = await insertAccount(db);
    const user = await insertUser(db, { accountId: account.id });
    const { service, links } = await buildBoth();
    const invite = await links.issue('invite', user.id);

    expect((await service.revokeInvite(user.id, account.id))?.status).toBe(
      'invited',
    );

    const users = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, user.id));
    expect(users).toHaveLength(0);
    expect(await inviteIsLive(links, invite)).toBe(false);
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
    const { service, links } = await buildBoth();
    const invite = await links.issue('invite', user.id);

    expect(await service.revokeInvite(user.id, other.id)).toBeUndefined();
    expect(await inviteIsLive(links, invite)).toBe(true);
  });
});
