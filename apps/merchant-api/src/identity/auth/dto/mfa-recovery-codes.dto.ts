import { ApiProperty } from '@nestjs/swagger';

// plaintext codes — returned exactly once, at confirm/regenerate time. Never
// retrievable again after this response (only bcrypt hashes are persisted).
export class MfaRecoveryCodesDto {
  @ApiProperty({ type: [String] })
  recoveryCodes: string[];
}
