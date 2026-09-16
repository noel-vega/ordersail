import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  token: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  password: string;

  constructor(token: string, password: string) {
    this.token = token;
    this.password = password;
  }
}
