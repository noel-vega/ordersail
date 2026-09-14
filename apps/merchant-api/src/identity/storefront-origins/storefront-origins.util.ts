// Normalizes a merchant-submitted origin to scheme+host only (drops any
// path/query/hash) and rejects anything that isn't a well-formed http(s)
// origin — this string is checked verbatim against the request's Origin
// header in storefront-api's AppKeyGuard tenant-scoping check, so it must
// be exact.
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
