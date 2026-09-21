import { Inject, Injectable } from '@nestjs/common';
import { and, type db as Db, eq, gt } from 'db/identity';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { type DbTransaction } from 'src/shared/database/database.types';
import { generateToken } from 'src/shared/common/generate-token.util';
import { emailedLinkDigest } from './emailed-link-digest';
import {
  EMAILED_LINK_KINDS,
  type EmailedLinkKind,
  type EmailedLinkKindName,
} from './emailed-link-kinds';

// 256 bits. The secret is the whole of what an Emailed link proves, and it
// travels in a URL, so it is generated once and never stored — only
// emailedLinkDigest() of it is.
const EMAILED_LINK_SECRET_BYTES = 32;

// What a redemption comes to. A discriminated result rather than a thrown
// sentinel because the effect may throw too, and a caller that wrapped this
// call in try/catch to map "invalid" would swallow the effect's own refusal
// with it — the deactivated invitee and the wrong-owner verification link
// are exactly that, and they must keep their own answers.
//
// `redeemed: false` is the single refusal: unknown, expired and already
// used are one outcome, so a link is never an oracle. Callers map it to
// their own status and message (unauthorized for a reset or an Invite,
// bad-request for email verification, whose caller is signed in and whose
// 401 the SDK would answer by refreshing and retrying).
export type EmailedLinkRedemption<T> =
  { redeemed: true; result: T } | { redeemed: false };

// What a claimed link is handed to. Runs inside redeem's transaction, so
// whatever it writes and the link's disappearance are one fact: if it
// throws, the claim rolls back and the link still works.
export type EmailedLinkEffect<T> = (
  tx: DbTransaction,
  subjectId: number,
) => Promise<T>;

// The one place that knows what an Emailed link is: how it is issued
// (issue), how it is recognised and used up (redeem) and how it is withdrawn
// (revokeAllForSubject). The only code that reads or writes user_invites,
// user_password_resets or user_email_verifications, and — with
// emailed-link-digest.ts — the only code that knows the digest.
//
// It never sees a URL or an email address: a caller is handed the secret and
// decides what link to build from it and where to send it. That is also what
// keeps it liftable into a shared package for the storefront Customer flows
// (OS-546) — it takes its executor and its kind as parameters and imports
// nothing from the sign-in or users modules.
//
// LOCK ORDER. Every operation here locks the subject's row FOR UPDATE
// before it touches a link row, and that is the point of a kind declaring
// its subject table. Two reasons:
//
//  1. The rule the rest of Identity already keeps: the subject's row comes
//     before any other row. UsersService.setDeactivated writes the User row
//     and then sweeps their Sessions;
//     SessionsService.revokeAllFamiliesForUser takes that row FOR UPDATE
//     before it touches a token row. A redemption that claimed the link
//     first and only then ran an effect over the User row would take those
//     rows in the opposite order from a concurrent deactivation, and
//     Postgres would abort one of the two — a 500, rare and
//     unreproducible, which is the class of defect the Sessions review
//     caught twice. Since OS-559 a deactivation withdraws links too, so the
//     two transactions touch exactly the same rows and the order is the
//     only thing keeping them apart.
//  2. So that the three operations serialize against each other and against
//     a deactivation for the same subject, rather than partly. The foreign
//     key does some of this for free — inserting a link row takes a KEY
//     SHARE lock on the User it references — but only some: replacing an
//     existing link is an UPDATE that rechecks no foreign key, so a
//     re-issue would otherwise be free to land in the middle of a
//     redemption of the link it replaces. One rule in one place beats
//     three callers reasoning about which statement happens to lock what.
//
// The lock is exclusive rather than shared because every effect writes the
// subject's row; two redemptions each holding a shared lock and both trying
// to upgrade would deadlock on each other.
@Injectable()
export class EmailedLinksService {
  constructor(@Inject(DRIZZLE) private readonly db: typeof Db) {}

  // A fresh link of this kind for this subject, replacing any outstanding
  // one — so only the newest email ever works. The secret is returned here
  // and nowhere else, ever again.
  //
  // `tx` lets the issue share a caller's transaction, so that "the pending
  // Staff record exists" and "its Invite exists" commit or roll back
  // together. Without one this opens its own, because the subject lock and
  // the write have to be the same transaction to mean anything.
  async issue(
    kindName: EmailedLinkKindName,
    subjectId: number,
    tx?: DbTransaction,
  ): Promise<string> {
    const kind = EMAILED_LINK_KINDS[kindName];
    const secret = generateToken(EMAILED_LINK_SECRET_BYTES);
    const digest = emailedLinkDigest(secret);
    const expiresAt = new Date(Date.now() + kind.ttlMs);

    const write = async (tx: DbTransaction) => {
      await this.lockSubject(tx, kind, subjectId);
      // One row per subject per kind — the unique constraint on the subject
      // column is what makes "issuing replaces the last one" a fact rather
      // than a convention, and it is why expired rows never accumulate.
      await tx
        .insert(kind.table)
        .values({ userId: subjectId, token: digest, expiresAt })
        .onConflictDoUpdate({
          target: kind.table.userId,
          set: { token: digest, expiresAt },
        });
    };

    await (tx ? write(tx) : this.db.transaction(write));
    return secret;
  }

  // Uses a link up and does what it was for, as one fact. Either the effect
  // ran and the link is gone, or neither happened and the link still works.
  //
  // The order inside the transaction is deliberate:
  //
  //  1. An unlocked read of which subject this digest names, refusing at
  //     once if none. This is only a hint — it takes no lock and decides
  //     nothing, because two redeemers of the same live link both pass it.
  //     It exists solely to learn which subject row to lock.
  //  2. That subject's row, FOR UPDATE. See the lock-order note above.
  //  3. The claim: one statement, DELETE ... WHERE the digest matches AND
  //     the row has not expired, RETURNING the subject. THIS is what makes
  //     a link single-use. Postgres serializes the two DELETEs on the row;
  //     the loser re-evaluates its WHERE against the just-committed state,
  //     matches nothing, and comes back empty. The same conditional-write
  //     idiom as recovery codes, WebAuthn challenges and refresh-token
  //     rotation.
  //  4. The effect, with the transaction and the subject the claim
  //     returned — never the one the unlocked read guessed.
  //
  // There is no non-consuming "peek", deliberately: a caller that wants to
  // refuse without using the link up (email verification's wrong-owner
  // case) throws from the effect, which rolls the claim back.
  //
  // And no `tx` parameter, unlike issue and revokeAllForSubject: this
  // operation owns its transaction. What a caller would otherwise want to
  // join it to is its own work, and that already runs inside this one, as
  // the effect. Handing it someone else's transaction would only let the
  // claim and the effect commit apart, which is the one fact redeem exists
  // to make.
  async redeem<T>(
    kindName: EmailedLinkKindName,
    secret: string,
    effect: EmailedLinkEffect<T>,
  ): Promise<EmailedLinkRedemption<T>> {
    const kind = EMAILED_LINK_KINDS[kindName];
    const digest = emailedLinkDigest(secret);

    return await this.db.transaction(async (tx) => {
      const [named] = await tx
        .select({ subjectId: kind.table.userId })
        .from(kind.table)
        .where(eq(kind.table.token, digest));
      if (!named) {
        return { redeemed: false };
      }

      await this.lockSubject(tx, kind, named.subjectId);

      // Expiry is measured against this process's clock, not the database's
      // now(). The columns are `timestamp` without a time zone and every
      // expiresAt in them was written from a JS Date, so comparing against
      // another JS Date is exact wherever the server's TimeZone setting
      // happens to point — which a bare now() would not be. Atomicity comes
      // from this being one statement, not from whose clock it reads.
      const [claimed] = await tx
        .delete(kind.table)
        .where(
          and(
            eq(kind.table.token, digest),
            gt(kind.table.expiresAt, new Date()),
          ),
        )
        .returning({ subjectId: kind.table.userId });
      if (!claimed) {
        return { redeemed: false };
      }

      return { redeemed: true, result: await effect(tx, claimed.subjectId) };
    });
  }

  // Withdraws this subject's outstanding links of the named kinds — for the
  // moments when nothing of theirs should still work. Which kinds is the
  // caller's decision, not this module's: deactivation withdraws a User's
  // reset and verification links but deliberately leaves a pending Invite
  // alone, so reactivating someone switched off by mistake doesn't force a
  // re-invite.
  //
  // Takes the subject lock for the same reason issue and redeem do, and
  // accepts a caller's transaction so that "deactivated" and "holds no live
  // link" commit as one fact.
  async revokeAllForSubject(
    subjectId: number,
    kindNames: readonly EmailedLinkKindName[],
    tx?: DbTransaction,
  ): Promise<void> {
    if (kindNames.length === 0) return;
    const kinds = kindNames.map((kindName) => EMAILED_LINK_KINDS[kindName]);

    const revoke = async (tx: DbTransaction) => {
      // Lock once, delete n. One subjectId means one subject row, however
      // many kinds hang off it — kinds named in the same call are always
      // kinds of the same subject, or the id would name two different
      // people — so any of them answers which row to take, and the
      // withdrawal that follows is n statements under that one lock.
      await this.lockSubject(tx, kinds[0], subjectId);
      for (const kind of kinds) {
        await tx.delete(kind.table).where(eq(kind.table.userId, subjectId));
      }
    };

    await (tx ? revoke(tx) : this.db.transaction(revoke));
  }

  // The one rule this module enforces on everyone's behalf: the subject's
  // row is locked before any link row. Cheap to repeat — a transaction that
  // already holds the row takes it again for nothing — which is what lets
  // every operation open with it rather than reasoning about who called it.
  private async lockSubject(
    tx: DbTransaction,
    kind: EmailedLinkKind,
    subjectId: number,
  ): Promise<void> {
    await tx
      .select({ id: kind.subjectTable.id })
      .from(kind.subjectTable)
      .where(eq(kind.subjectTable.id, subjectId))
      .for('update');
  }
}
