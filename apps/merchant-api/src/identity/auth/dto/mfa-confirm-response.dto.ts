import { ApiProperty } from '@nestjs/swagger';

export class MfaConfirmResponseDto {
  // plaintext codes — returned exactly once, at confirm time. Never
  // retrievable again after this response (only bcrypt hashes are persisted).
  @ApiProperty({ type: [String] })
  recoveryCodes: string[];

  // a fresh access token with mfaEnrollmentSatisfied now true — lets a
  // caller who was gated into forced enrollment (OS-473) continue
  // immediately, without waiting for their token to naturally refresh
  @ApiProperty()
  access_token: string;
}
