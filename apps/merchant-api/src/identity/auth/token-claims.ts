import { type AuthenticatedUser } from 'src/shared/auth/decorators';

// The claims every minted token carries, independent of which kind of token
// it is. `typ` and `jti` are envelope fields the mint helpers add
// themselves, so they deliberately aren't here.
//
// This exists as one object rather than a positional parameter list because
// the claim set is mostly booleans and is still growing (emailVerified came
// with OS-470, mfaEnrollmentSatisfied with OS-473, hasMfaFactor with
// OS-484). Past seven positionals
// with three adjacent booleans, a transposed argument type-checks cleanly
// and silently mints a wrong auth claim.
export interface TokenClaims {
  sub: number;
  email: string;
  accountId: number;
  firstName: string;
  lastName: string;
  emailVerified: boolean;
  mfaEnrollmentSatisfied: boolean;
  hasMfaFactor: boolean;
}

// Maps a request's decoded token back to the claim set, for the handlers
// that re-mint a caller's own token (AuthController.confirmMfa).
//
// Deliberately field-by-field rather than a spread: AuthenticatedUser also
// carries the JWT envelope (typ, jti) plus whatever jsonwebtoken added
// (iat, exp), and spreading those into a fresh sign() call would copy a
// refresh token's `typ`/`jti` or a stale `exp` onto the new token.
export function claimsFromUser(user: AuthenticatedUser): TokenClaims {
  return {
    sub: user.sub,
    email: user.email,
    accountId: user.accountId,
    firstName: user.firstName,
    lastName: user.lastName,
    emailVerified: user.emailVerified,
    mfaEnrollmentSatisfied: user.mfaEnrollmentSatisfied,
    hasMfaFactor: user.hasMfaFactor,
  };
}
