import { eq, usersTable } from 'db/identity';
import {
  deactivateUser,
  insertAccountWithUser,
  lockWaiters,
  raceForUserRow,
  useTestDb,
} from 'test-support';
import { type DbTransaction } from 'src/shared/database/database.types';
import { emailedLinkDigest } from './emailed-link-digest';
import {
  EMAILED_LINK_KINDS,
  EMAILED_LINK_KIND_NAMES,
  type EmailedLinkKindName,
} from './emailed-link-kinds';
import { EmailedLinksService } from './emailed-links.service';
import {
  expireEmailedLink,
  outstandingLinkCount,
} from './emailed-links.spec-support';

// The Emailed links seam. Every question here is one a person could ask of
// a link they were sent: does following it do the thing, does it work a
// second time, does it still work after something went wrong, does the
// newest email win. Nothing asserts a digest or a row id, and no spec
// writes a link row by hand — a link only ever comes from issue().
//
// Written once and run per kind, because the whole point of the module is
// that an Invite, a password reset and an email verification differ in
// their lifetime, their table and what they are for, and in nothing else.

const db = useTestDb();

const service = () => new EmailedLinksService(db);

async function seedSubject() {
  return (await insertAccountWithUser(db)).user;
}

// The effects in this suite write the subject's row, because all three real
// ones do (set the password, verify the email, activate the Staff record) —
// and because a race that is staged on that row needs its contenders to
// want it. The column is arbitrary: nothing else in this suite reads it.
function renameTo(name: string) {
  return async (tx: DbTransaction, subjectId: number) => {
    await tx
      .update(usersTable)
      .set({ firstname: name })
      .where(eq(usersTable.id, subjectId));
    return subjectId;
  };
}

async function firstnameOf(userId: number): Promise<string | undefined> {
  const [row] = await db
    .select({ firstname: usersTable.firstname })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return row?.firstname;
}

describe.each(EMAILED_LINK_KIND_NAMES)('Emailed link: %s', (kind) => {
  it('runs the effect for the subject the link was issued to, and uses the link up', async () => {
    const subject = await seedSubject();
    const links = service();

    const secret = await links.issue(kind, subject.id);
    const outcome = await links.redeem(kind, secret, renameTo('Redeemed'));

    expect(outcome).toEqual({ redeemed: true, result: subject.id });
    expect(await firstnameOf(subject.id)).toBe('Redeemed');
    expect(await outstandingLinkCount(db, kind, subject.id)).toBe(0);
  });

  it('refuses the same link a second time, and the effect does not run again', async () => {
    const subject = await seedSubject();
    const links = service();
    const secret = await links.issue(kind, subject.id);
    await links.redeem(kind, secret, renameTo('First'));

    const second = await links.redeem(kind, secret, renameTo('Second'));

    expect(second).toEqual({ redeemed: false });
    expect(await firstnameOf(subject.id)).toBe('First');
  });

  it('refuses a secret nobody was ever sent', async () => {
    await seedSubject();
    const effect = jest.fn();

    const outcome = await service().redeem(kind, 'never-issued', effect);

    expect(outcome).toEqual({ redeemed: false });
    expect(effect).not.toHaveBeenCalled();
  });

  it('refuses an expired link without running the effect', async () => {
    const subject = await seedSubject();
    const links = service();
    const secret = await links.issue(kind, subject.id);
    await expireEmailedLink(db, kind, subject.id);
    const effect = jest.fn();

    const outcome = await links.redeem(kind, secret, effect);

    expect(outcome).toEqual({ redeemed: false });
    expect(effect).not.toHaveBeenCalled();
  });

  it('kills the previous link when a new one is issued — only the newest email works', async () => {
    const subject = await seedSubject();
    const links = service();

    const first = await links.issue(kind, subject.id);
    const second = await links.issue(kind, subject.id);

    expect(await links.redeem(kind, first, renameTo('Old'))).toEqual({
      redeemed: false,
    });
    expect(await links.redeem(kind, second, renameTo('New'))).toEqual({
      redeemed: true,
      result: subject.id,
    });
    // ...and the replacement happened in place, rather than leaving the
    // subject holding two outstanding links of one kind
    expect(await firstnameOf(subject.id)).toBe('New');
  });

  it('leaves the link redeemable when the effect throws — nothing it wrote survives either', async () => {
    const subject = await seedSubject();
    const links = service();
    const secret = await links.issue(kind, subject.id);
    const before = await firstnameOf(subject.id);

    await expect(
      links.redeem(kind, secret, async (tx, subjectId) => {
        await renameTo('Half done')(tx, subjectId);
        throw new Error('the effect refused');
      }),
    ).rejects.toThrow('the effect refused');

    expect(await firstnameOf(subject.id)).toBe(before);
    expect(await links.redeem(kind, secret, renameTo('Retried'))).toEqual({
      redeemed: true,
      result: subject.id,
    });
    expect(await firstnameOf(subject.id)).toBe('Retried');
  });

  // The case a link is single-use *for*. Lookup, act and delete as separate
  // statements pass this sequentially and fail here: both requests read a
  // live row, and both act. Staged on the subject's row (see
  // raceForUserRow) so it is a race every run, not on the runs where the
  // scheduler happens to oblige.
  it('runs the effect exactly once when the same link is redeemed twice at once, and refuses the loser', async () => {
    const subject = await seedSubject();
    const links = service();
    const secret = await links.issue(kind, subject.id);
    const effect = jest.fn(renameTo('Winner'));

    const outcomes = await raceForUserRow(db, subject.id, 2, () =>
      Promise.all([
        links.redeem(kind, secret, effect),
        links.redeem(kind, secret, effect),
      ]),
    );

    expect(effect).toHaveBeenCalledTimes(1);
    expect(outcomes).toContainEqual({ redeemed: true, result: subject.id });
    expect(outcomes).toContainEqual({ redeemed: false });
    expect(await firstnameOf(subject.id)).toBe('Winner');
    expect(await outstandingLinkCount(db, kind, subject.id)).toBe(0);
  });

  it('rolls back with the caller when issued inside their transaction', async () => {
    const subject = await seedSubject();
    const links = service();
    let secret: string | undefined;

    await expect(
      db.transaction(async (tx) => {
        secret = await links.issue(kind, subject.id, tx);
        throw new Error('the caller gave up');
      }),
    ).rejects.toThrow('the caller gave up');

    expect(secret).toBeDefined();
    expect(await links.redeem(kind, secret!, renameTo('Never'))).toEqual({
      redeemed: false,
    });
  });
});

describe('Emailed links are not interchangeable', () => {
  it.each(
    EMAILED_LINK_KIND_NAMES.flatMap((issued) =>
      EMAILED_LINK_KIND_NAMES.filter((other) => other !== issued).map(
        (presented) => ({ issued, presented }),
      ),
    ),
  )(
    'refuses a $issued secret presented as a $presented, and leaves it usable',
    async ({ issued, presented }) => {
      const subject = await seedSubject();
      const links = service();
      const secret = await links.issue(issued, subject.id);

      expect(await links.redeem(presented, secret, renameTo('Wrong'))).toEqual({
        redeemed: false,
      });
      expect(await links.redeem(issued, secret, renameTo('Right'))).toEqual({
        redeemed: true,
        result: subject.id,
      });
    },
  );
});

describe('EmailedLinksService.revokeAllForSubject', () => {
  it('withdraws the named kinds and leaves the others alone', async () => {
    const subject = await seedSubject();
    const links = service();
    const invite = await links.issue('invite', subject.id);
    const reset = await links.issue('passwordReset', subject.id);
    const verification = await links.issue('emailVerification', subject.id);

    await links.revokeAllForSubject(subject.id, [
      'passwordReset',
      'emailVerification',
    ]);

    expect(await links.redeem('passwordReset', reset, renameTo('R'))).toEqual({
      redeemed: false,
    });
    expect(
      await links.redeem('emailVerification', verification, renameTo('V')),
    ).toEqual({ redeemed: false });
    // the Invite deliberately survives: deactivating someone by mistake
    // shouldn't force a re-invite (OS-559)
    expect(await links.redeem('invite', invite, renameTo('I'))).toEqual({
      redeemed: true,
      result: subject.id,
    });
  });

  it("leaves another subject's links of the same kind alone", async () => {
    const mine = await seedSubject();
    const theirs = await seedSubject();
    const links = service();
    const ours = await links.issue('passwordReset', mine.id);
    const yours = await links.issue('passwordReset', theirs.id);

    await links.revokeAllForSubject(mine.id, ['passwordReset']);

    expect(await links.redeem('passwordReset', ours, renameTo('M'))).toEqual({
      redeemed: false,
    });
    expect(await links.redeem('passwordReset', yours, renameTo('T'))).toEqual({
      redeemed: true,
      result: theirs.id,
    });
  });

  it('joins a caller transaction, and is undone with it', async () => {
    const subject = await seedSubject();
    const links = service();
    const reset = await links.issue('passwordReset', subject.id);

    await expect(
      db.transaction(async (tx) => {
        await links.revokeAllForSubject(subject.id, ['passwordReset'], tx);
        throw new Error('the caller gave up');
      }),
    ).rejects.toThrow('the caller gave up');

    expect(
      await links.redeem('passwordReset', reset, renameTo('Still')),
    ).toEqual({ redeemed: true, result: subject.id });
  });
});

// Two concurrent operations on the same User that take the same rows in
// opposite orders don't queue — Postgres aborts one of them, as a 500 that
// shows up rarely and never reproduces. That is the class of defect the
// Sessions review caught twice, so each pair the module can be half of gets
// a spec, and every one of them turns on redeem/issue/revoke taking the
// subject's row before any link row.
describe('lock order', () => {
  // Issuing takes the subject's row too, so a replacement link can't land
  // in the middle of a redemption of the link it replaces — it queues
  // behind it and the two outcomes are both whole. Without that lock the
  // staging fails outright ("the race was not staged"), because replacing
  // an existing link is an UPDATE that waits on nothing the redemption
  // holds.
  it('waits for a redemption in flight before replacing the link it is using', async () => {
    const subject = await seedSubject();
    const links = service();
    const secret = await links.issue('passwordReset', subject.id);

    const [outcome, replacement] = await raceForUserRow(
      db,
      subject.id,
      2,
      async () => {
        const redeeming = links.redeem(
          'passwordReset',
          secret,
          renameTo('Redeemed'),
        );
        redeeming.catch(() => undefined);
        await lockWaiters(db, 1);
        return Promise.all([
          redeeming,
          links.issue('passwordReset', subject.id),
        ]);
      },
    );

    // the redemption queued first, so it did its job; the link issued
    // behind it is what is outstanding afterwards, and it works.
    expect(outcome).toEqual({ redeemed: true, result: subject.id });
    expect(await firstnameOf(subject.id)).toBe('Redeemed');
    expect(
      await links.redeem('passwordReset', replacement, renameTo('Second')),
    ).toEqual({ redeemed: true, result: subject.id });
  });

  // Deactivation writes the User row and then rows that hang off it, and a
  // redemption must go the same way round. Deactivating here is a bare
  // UPDATE rather than UsersService.setDeactivated, so that this module's
  // suite stays a leaf like the module — the real deactivation, which since
  // OS-559 withdraws links as well and so closes the cycle properly, is
  // raced against a redemption in users.service.spec.
  it('does not deadlock when a User is deactivated mid-redemption', async () => {
    const subject = await seedSubject();
    const links = service();
    const secret = await links.issue('passwordReset', subject.id);

    const [outcome] = await raceForUserRow(db, subject.id, 2, async () => {
      const redeeming = links.redeem(
        'passwordReset',
        secret,
        renameTo('Redeemed'),
      );
      redeeming.catch(() => undefined);
      await lockWaiters(db, 1);
      return Promise.all([redeeming, deactivateUser(db, subject.id)]);
    });

    // both transactions completed — neither was aborted as a deadlock
    // victim — and the redemption, which queued first, did its job
    expect(outcome).toEqual({ redeemed: true, result: subject.id });
    expect(await firstnameOf(subject.id)).toBe('Redeemed');
    expect(await outstandingLinkCount(db, 'passwordReset', subject.id)).toBe(0);
  });
});

describe('the digest', () => {
  it('is what is stored, never the secret itself', async () => {
    const subject = await seedSubject();
    const secret = await service().issue('passwordReset', subject.id);

    const [row] = await db
      .select({ token: EMAILED_LINK_KINDS.passwordReset.table.token })
      .from(EMAILED_LINK_KINDS.passwordReset.table)
      .where(eq(EMAILED_LINK_KINDS.passwordReset.table.userId, subject.id));

    expect(row?.token).not.toBe(secret);
    expect(row?.token).toBe(emailedLinkDigest(secret));
  });

  it.each(EMAILED_LINK_KIND_NAMES)(
    'is unguessable: a %s secret is never reused between issues',
    async (kind: EmailedLinkKindName) => {
      const subject = await seedSubject();
      const links = service();

      const secrets = new Set<string>();
      for (let i = 0; i < 5; i++) {
        secrets.add(await links.issue(kind, subject.id));
      }

      expect(secrets.size).toBe(5);
    },
  );
});
