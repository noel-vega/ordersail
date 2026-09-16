import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class MfaVerifyDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  challengeToken: string;

  // a TOTP code (6 digits) or a recovery code ("XXXXX-XXXXX") — loose
  // validation here, the actual check happens in AuthService
  @ApiProperty()
  @IsString()
  @MinLength(6)
  code: string;

  constructor(challengeToken: string, code: string) {
    this.challengeToken = challengeToken;
    this.code = code;
  }
}
