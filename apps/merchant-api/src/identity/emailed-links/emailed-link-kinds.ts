import {
  userEmailVerificationsTable,
  userInvitesTable,
  userPasswordResetsTable,
  usersTable,
} from 'db/identity';

// The three link tables are column-for-column identical — id, a unique
// subject FK, a unique digest, an expiry — and deliberately stay three
// tables rather than one with a purpose column (decided 2026-09-16, and
// again for the storefront Customer flows). A union of the three is what
// lets every statement in EmailedLinksService be written once: drizzle
// resolves `table.userId` / `table.token` / `table.expiresAt` across it
// because all three agree on those names. Adding a fourth kind means adding
// its table here and an entry below — no new SQL.
type EmailedLinkTable =
  | typeof userInvitesTable
  | typeof userPasswordResetsTable
  | typeof userEmailVerificationsTable;

// The table an Emailed link's subject lives in. One today; a storefront
// Customer's links would name theirs, which is the reason this is declared
// per kind rather than assumed. Declaring it is what lets *redeem* take the
// subject-row lock itself instead of trusting each caller to remember —
// see EmailedLinksService for why that lock comes first.
type EmailedLinkSubjectTable = typeof usersTable;

export interface EmailedLinkKind {
  // How long a link of this kind is good for. Declared with the kind, so
  // "how long does an Invite last" is answered in one place rather than by
  // a constant in whichever module happens to issue it.
  readonly ttlMs: number;
  readonly table: EmailedLinkTable;
  readonly subjectTable: EmailedLinkSubjectTable;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const EMAILED_LINK_KINDS = {
  // Long enough that an invited person doesn't have to act the moment the
  // email arrives; they can't ask for a new one themselves, only an Owner
  // can resend.
  invite: {
    ttlMs: 7 * DAY_MS,
    table: userInvitesTable,
    subjectTable: usersTable,
  },
  // Deliberately much shorter than an Invite's — an existing active User
  // can always request a fresh link, so there is no cost to expiring fast,
  // and an old reset email in an inbox is a standing key to a password.
  passwordReset: {
    ttlMs: HOUR_MS,
    table: userPasswordResetsTable,
    subjectTable: usersTable,
  },
  // No urgency signal the way a password reset has ("someone might be
  // taking over your account right now"), so a generous window is fine.
  emailVerification: {
    ttlMs: DAY_MS,
    table: userEmailVerificationsTable,
    subjectTable: usersTable,
  },
} as const satisfies Record<string, EmailedLinkKind>;

export type EmailedLinkKindName = keyof typeof EMAILED_LINK_KINDS;

// Every kind there is, for the suite that runs once per kind.
export const EMAILED_LINK_KIND_NAMES = Object.keys(
  EMAILED_LINK_KINDS,
) as EmailedLinkKindName[];
