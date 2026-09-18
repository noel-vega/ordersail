import { env } from 'src/shared/env';

// The relying-party identity every WebAuthn ceremony is scoped to.
//
// Derived from MERCHANT_WEB_URL rather than configured separately, because
// that variable already carries the dashboard's address and is already
// correct in every environment: dev gives rpID 'localhost' + origin
// 'http://localhost:5000', prod gives 'merchant.ordersail.com' +
// 'https://merchant.ordersail.com'. One fewer value to get wrong.
//
// The RP ID is scoped to the dashboard subdomain, deliberately, and this is
// a one-way door:
//
//   - It is baked into every credential at registration and cannot be
//     changed. Moving the dashboard to another hostname would invalidate
//     every passkey in existence, with no migration path. (Nobody is locked
//     out — password, recovery codes and TOTP still work — but everyone
//     would have to re-register.)
//   - The apex (ordersail.com) would avoid that, at the cost of letting any
//     script on the marketing site request an assertion for this RP: an RP
//     ID must be the calling page's domain *or a parent of it*, so an XSS
//     on ordersail.com would become an account-takeover path for the
//     dashboard. The subdomain makes that structurally impossible.
//
// Lives here rather than in shared/env.ts so env.ts stays a pure schema and
// this derivation is directly testable.
function deriveRpId(): string {
  return env.WEBAUTHN_RP_ID ?? new URL(env.MERCHANT_WEB_URL).hostname;
}

function deriveOrigins(): string[] {
  if (!env.WEBAUTHN_ORIGINS) return [new URL(env.MERCHANT_WEB_URL).origin];
  return env.WEBAUTHN_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export const webauthnConfig = {
  rpID: deriveRpId(),
  rpName: env.WEBAUTHN_RP_NAME,
  expectedOrigins: deriveOrigins(),
};

// How long a ceremony's challenge stays redeemable. Matches
// MFA_CHALLENGE_TTL — long enough to pick a passkey out of a password
// manager, short enough that an intercepted challenge is worth little.
export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
