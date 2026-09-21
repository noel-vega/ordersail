import { eq, usersTable } from 'db/identity';
import { type TestDb } from 'test-support';
import {
  EMAILED_LINK_KINDS,
  type EmailedLinkKindName,
} from './emailed-link-kinds';
import { type EmailedLinkEffect } from './emailed-links.service';

// Spec-only helpers for Emailed links. App-local rather than in
// test-support because each of them needs something only merchant-api has
// — a kind's table through EMAILED_LINK_KINDS, the effect signature, or
// the shape of the URLs this app emails — and packages/test-support cannot
// import an app. What needs nothing but the database lives there instead
// (firstnameOf, the other half of renameTo below). Excluded from the build
// by tsconfig.build.json.
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

// Stands in for the three real effects — set the password, mark the email
// verified, activate the Staff record — in the one respect every spec here
// depends on: it writes the subject's own row. That is what puts a
// redemption and a concurrent deactivation after the same rows, so a race
// staged on that row has contenders that actually want it. The column is
// arbitrary; read it back with test-support's firstnameOf.
export function renameTo(name: string): EmailedLinkEffect<number> {
  return async (tx, subjectId) => {
    await tx
      .update(usersTable)
      .set({ firstname: name })
      .where(eq(usersTable.id, subjectId));
    return subjectId;
  };
}

// The secret as the person receives it: out of the `?token=` in the nth
// email of some kind, which is the only place it is ever readable. Which
// email was sent and which field carries the URL are the flow's, so the
// caller names them; everything after that is the same for every kind.
//
// Following the emailed link rather than reading the row behind it is the
// point — a flow that mailed a secret the module never minted would pass
// the row check and fail a person.
export function emailedLinkSecret<Params>(
  sendEmail: jest.Mock,
  urlOf: (params: Params) => string,
  call = 0,
): string {
  const args = sendEmail.mock.calls[call] as [string, Params] | undefined;
  if (!args) {
    throw new Error(`emailedLinkSecret: no email was sent on call ${call}`);
  }
  const url = urlOf(args[1]);
  const secret = new URL(url).searchParams.get('token');
  if (!secret) {
    throw new Error(`emailedLinkSecret: no secret in the emailed URL ${url}`);
  }
  return secret;
}
