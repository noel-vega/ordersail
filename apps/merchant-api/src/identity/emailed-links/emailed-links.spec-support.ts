import { eq } from 'db/identity';
import { type TestDb } from 'test-support';
import {
  EMAILED_LINK_KINDS,
  type EmailedLinkKindName,
} from './emailed-link-kinds';

// Spec-only helpers for Emailed links. App-local rather than in
// test-support because both reach a kind's table through
// EMAILED_LINK_KINDS, which is this module's — and packages/test-support
// cannot import an app. Excluded from the build by tsconfig.build.json.
//
// There is deliberately no helper that seeds a link row: every flow now
// issues through the module (OS-529 took the last one, email verification,
// and OS-530 Invites), so a spec that wants a live link calls issue() and
// the digest stays the module's business alone. test-support carried a
// hand-copied digest until OS-509, which is the class of bug where the
// fixtures and the code agree with each other and both are wrong.

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
