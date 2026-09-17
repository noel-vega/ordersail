import { createHash, randomBytes } from 'crypto';

export function generateToken(byteLength: number): string {
  return randomBytes(byteLength).toString('base64url');
}

// Emailed single-use tokens (invite, password reset, email verification)
// are stored only as this digest, so a database read (backup, SQLi, support
// query) can't be replayed as a live link. A fast unsalted SHA-256 is
// enough: generateToken(32) has 256 bits of entropy, nothing to brute-force.
// Must stay byte-for-byte equal to the SQL backfill in packages/db
// (encode(sha256(convert_to(token, 'UTF8')), 'hex')) and the test fixtures.
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
