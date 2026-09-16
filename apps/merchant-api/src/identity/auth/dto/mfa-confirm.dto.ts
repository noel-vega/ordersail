import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class MfaConfirmDto {
  @ApiProperty()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Code must be 6 digits' })
  code: string;

  constructor(code: string) {
    this.code = code;
  }
}
