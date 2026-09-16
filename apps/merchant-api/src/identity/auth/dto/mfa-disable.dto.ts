import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class MfaDisableDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  password: string;

  constructor(password: string) {
    this.password = password;
  }
}
