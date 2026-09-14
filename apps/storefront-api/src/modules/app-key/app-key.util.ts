// Mirrors apps/merchant-api/src/identity/storefront-origins/storefront-origins.util.ts —
// apps can't import each other's code, so this is duplicated; keep both in sync.
// Normalizes to scheme+host only (drops any path/query/hash) and rejects
// anything that isn't a well-formed http(s) origin, so a stored/incoming
// origin compares exactly regardless of how it was typed/submitted.
export function normalizeOrigin(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (url.search || url.hash) return null;
  return `${url.protocol}//${url.host}`;
}

// always allowed outside production, regardless of what's registered, so
// local dev never needs to register localhost as a storefront origin
export const LOCAL_DEV_ORIGIN = 'http://localhost:3002';

export function isLocalDevOrigin(origin: string, nodeEnv: string): boolean {
  return origin === LOCAL_DEV_ORIGIN && nodeEnv !== 'production';
}
