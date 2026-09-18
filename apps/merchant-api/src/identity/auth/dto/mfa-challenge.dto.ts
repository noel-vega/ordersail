import { ApiProperty } from '@nestjs/swagger';

// returned by POST /auth/signin instead of AccessTokenDto when the account
// has a confirmed MFA enrollment — the caller must exchange this for real
// tokens via POST /auth/mfa/verify or POST /auth/passkeys/challenge/verify
export class MfaChallengeDto {
  @ApiProperty({ enum: [true] })
  mfaRequired: true;

  @ApiProperty()
  challengeToken: string;

  // Which factors this specific user can actually present, so the challenge
  // step doesn't render a passkey button for someone who has none. It does
  // tell an unauthenticated caller what a given account holds — accepted,
  // since they've already proven the password to get here, and the
  // alternative is a dead button.
  @ApiProperty({ enum: ['passkey', 'totp', 'recovery'], isArray: true })
  methods: ('passkey' | 'totp' | 'recovery')[];
}
