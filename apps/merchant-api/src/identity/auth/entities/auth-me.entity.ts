import { ApiProperty } from '@nestjs/swagger';

// the current user's identity + effective permission keys — merchant-web reads
// this once on entering /app instead of decoding the JWT client-side (which
// carries no permissions anyway)
export class AuthMe {
  @ApiProperty()
  userId: number;

  @ApiProperty()
  email: string;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;

  @ApiProperty()
  accountId: number;

  @ApiProperty()
  emailVerified: boolean;

  // whether a TOTP factor is confirmed and active (OS-316) — merchant-web's
  // security page uses this to render "enroll" vs "manage" state. Named
  // totpEnabled since OS-484, when passkeys became a second kind of factor
  // and "mfaEnabled" stopped being unambiguous.
  @ApiProperty()
  totpEnabled: boolean;

  // how many passkeys this user holds. The passkey *list* deliberately isn't
  // here — /auth/me is cached with a 60s staleTime and cleared on every auth
  // mutation, which is the wrong lifecycle for a list the user edits; that
  // lives at GET /auth/passkeys (OS-485).
  @ApiProperty()
  passkeyCount: number;

  // holds any factor at all, TOTP or passkey — what the per-route gate
  // (OS-492) checks before a money/access-sensitive action
  @ApiProperty()
  hasMfaFactor: boolean;

  // false means the account requires MFA and this user hasn't finished
  // enrolling yet — merchant-web should route them into forced enrollment
  // (OS-473/OS-475) rather than the rest of the app
  @ApiProperty()
  mfaEnrollmentSatisfied: boolean;

  @ApiProperty({ type: [String] })
  permissions: string[];
}
