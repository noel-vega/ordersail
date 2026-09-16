import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

// required — a stolen bearer token alone shouldn't be enough to mint a
// fresh recovery-code backdoor for an account that already has MFA
// confirmed (see AuthService.regenerateRecoveryCodes)
export class MfaRegenerateRecoveryCodesDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  password: string;

  constructor(password: string) {
    this.password = password;
  }
}
