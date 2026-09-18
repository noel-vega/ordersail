import { type AuthenticatedUser } from 'src/shared/auth/decorators';
import { claimsFromUser } from './token-claims';

// A decoded refresh token as it actually arrives on a request: the claim
// set plus the JWT envelope. `iat`/`exp` aren't on AuthenticatedUser but
// jsonwebtoken puts them on the decoded object, so they're here too — they
// are exactly what must not survive the mapping.
const decodedRefreshToken = {
  sub: 7,
  email: 'dana@cactus.test',
  accountId: 3,
  firstName: 'Dana',
  lastName: 'Scully',
  emailVerified: true,
  mfaEnrollmentSatisfied: false,
  hasMfaFactor: true,
  typ: 'refresh',
  jti: 'f1f0c0de-0000-4000-8000-000000000000',
  iat: 1_700_000_000,
  exp: 1_700_600_000,
} as unknown as AuthenticatedUser;

describe('claimsFromUser (OS-482)', () => {
  it('carries every claim across', () => {
    expect(claimsFromUser(decodedRefreshToken)).toEqual({
      sub: 7,
      email: 'dana@cactus.test',
      accountId: 3,
      firstName: 'Dana',
      lastName: 'Scully',
      emailVerified: true,
      mfaEnrollmentSatisfied: false,
      hasMfaFactor: true,
    });
  });

  // The reason this maps field-by-field instead of spreading. Re-minting a
  // caller's token (AuthController.confirmMfa) starts from their *current*
  // decoded token — if the envelope came along, a refresh token's `typ` and
  // `jti` would land on the new access token (AuthGuard rejects `typ` other
  // than 'access', so every subsequent request would 401), and a stale
  // `exp` would either expire the token immediately or extend it past its
  // intended 8h.
  it.each(['typ', 'jti', 'iat', 'exp'])(
    'drops the JWT envelope field %s',
    (field) => {
      expect(claimsFromUser(decodedRefreshToken)).not.toHaveProperty(field);
    },
  );

  // Belt and braces for the two above: pins the key set itself, so a claim
  // added to TokenClaims without being mapped here is caught as well.
  it('produces exactly the claim set, nothing more', () => {
    expect(Object.keys(claimsFromUser(decodedRefreshToken)).sort()).toEqual([
      'accountId',
      'email',
      'emailVerified',
      'firstName',
      'hasMfaFactor',
      'lastName',
      'mfaEnrollmentSatisfied',
      'sub',
    ]);
  });
});
