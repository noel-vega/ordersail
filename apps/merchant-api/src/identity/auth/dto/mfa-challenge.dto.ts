import { ApiProperty } from '@nestjs/swagger';

// returned by POST /auth/signin instead of AccessTokenDto when the account
// has a confirmed MFA enrollment — the caller must exchange this for real
// tokens via POST /auth/mfa/verify
export class MfaChallengeDto {
  @ApiProperty({ enum: [true] })
  mfaRequired: true;

  @ApiProperty()
  challengeToken: string;
}
