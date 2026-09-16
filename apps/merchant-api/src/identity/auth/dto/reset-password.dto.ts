import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { IsStrongPassword } from 'password-policy';

export class ResetPasswordDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  token: string;

  @ApiProperty()
  @IsString()
  @MinLength(12)
  @IsStrongPassword()
  password: string;

  constructor(token: string, password: string) {
    this.token = token;
    this.password = password;
  }
}
