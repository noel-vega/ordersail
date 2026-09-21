import { eq, userEmailVerificationsTable, userInvitesTable } from 'db/identity';
import { type TestDb } from 'test-support';
import {
  EMAILED_LINK_KINDS,
  type EmailedLinkKindName,
} from './emailed-link-kinds';
import { emailedLinkDigest } from './emailed-link-digest';

// Spec-only helpers for Emailed links. App-local rather than in
// test-support because they have to agree with emailedLinkDigest(), and
// that function has exactly one home — this module. test-support carried a
// hand-copied digest until OS-509, which is the class of bug where the
// fixtures and the code agree with each other and both are wrong.
// Excluded from the build by tsconfig.build.json.

// Backdates a subject's outstanding link of this kind so that it has just
// expired. Ageing the row rather than faking the clock: the claim compares
// against a real Date, and other specs in the same file present links that
// must still be live.
export async function expireEmailedLink(
  db: TestDb,
  kindName: EmailedLinkKindName,
  subjectId: number,
): Promise<void> {
  const { table } = EMAILED_LINK_KINDS[kindName];
  await db
    .update(table)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(table.userId, subjectId));
}

// How many outstanding links of this kind the subject holds. Rows rather
// than behaviour, so only ever alongside a behavioural check — for the
// invariants no caller can see, such as "issuing replaced the old one
// rather than adding to it".
export async function outstandingLinkCount(
  db: TestDb,
  kindName: EmailedLinkKindName,
  subjectId: number,
): Promise<number> {
  const { table } = EMAILED_LINK_KINDS[kindName];
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(eq(table.userId, subjectId));
  return rows.length;
}

// An outstanding Invite for a User, with the secret a real emailed link
// would carry — the one thing a spec can't get back out of the database.
// Invites are still issued by hand in UsersService (OS-530 moves them onto
// the module); until then this is how a spec seeds one, through the real
// digest.
export async function seedInvite(
  db: TestDb,
  opts: { userId: number; secret?: string; expiresAt?: Date },
): Promise<string> {
  const secret = opts.secret ?? `invite-secret-${opts.userId}`;
  await db.insert(userInvitesTable).values({
    userId: opts.userId,
    token: emailedLinkDigest(secret),
    expiresAt:
      opts.expiresAt ?? new Date(Date.now() + EMAILED_LINK_KINDS.invite.ttlMs),
  });
  return secret;
}

// The same, for an outstanding email verification (OS-529 moves that flow
// onto the module).
export async function seedEmailVerification(
  db: TestDb,
  opts: { userId: number; secret?: string; expiresAt?: Date },
): Promise<string> {
  const secret = opts.secret ?? `verification-secret-${opts.userId}`;
  await db.insert(userEmailVerificationsTable).values({
    userId: opts.userId,
    token: emailedLinkDigest(secret),
    expiresAt:
      opts.expiresAt ??
      new Date(Date.now() + EMAILED_LINK_KINDS.emailVerification.ttlMs),
  });
  return secret;
}
