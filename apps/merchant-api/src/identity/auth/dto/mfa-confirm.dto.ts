import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MinLength } from 'class-validator';

export class MfaConfirmDto {
  @ApiProperty()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Code must be 6 digits' })
  code: string;

  // required — this is the step that activates a second factor, same
  // reauthentication bar as disabling one (see AuthService.disableMfa)
  @ApiProperty()
  @IsString()
  @MinLength(1)
  password: string;

  constructor(code: string, password: string) {
    this.code = code;
    this.password = password;
  }
}
