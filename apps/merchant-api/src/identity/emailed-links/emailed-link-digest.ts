import { createHash } from 'node:crypto';

// The one definition of how an Emailed link's secret is recognised. Only
// this digest is stored, so a database read (backup, SQLi, support query)
// can't be replayed as a live link. A fast unsalted SHA-256 is enough: the
// secret is generateToken(EMAILED_LINK_SECRET_BYTES) — 256 bits of entropy,
// nothing to brute-force, and nothing a salt would protect against.
//
// It lives on its own, apart from the service, because something outside
// the module must agree with it byte for byte and shouldn't have to
// construct a service to do so: the SQL backfill in packages/db
// (encode(sha256(convert_to(token, 'UTF8')), 'hex')), which
// hash-emailed-tokens.migration.spec.ts pins against this function by
// importing it. There was a second, hand-copied definition in
// packages/test-support until OS-509 — a fixture in the wrong encoding is a
// green suite that agrees with the bug.
export function emailedLinkDigest(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}
