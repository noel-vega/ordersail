import { randomBytes } from 'crypto';

// A random secret, base64url so it survives a URL and an email client
// untouched. Used for API keys, object-storage paths and the secret behind
// every Emailed link. How an Emailed link's secret is *recognised* is not
// here: that digest has one home, in the Emailed links module
// (identity/emailed-links/emailed-link-digest.ts).
export function generateToken(byteLength: number): string {
  return randomBytes(byteLength).toString('base64url');
}
