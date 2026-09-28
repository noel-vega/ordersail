import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { IsE164Phone } from 'src/shared/validation/is-e164-phone';

export class CreateUserDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  firstName: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  lastName: string;

  // stored as E.164 (OS-687)
  @ApiProperty({ example: '+12015550123' })
  @IsE164Phone()
  phone: string;

  @ApiProperty()
  @IsEmail()
  email: string;

  // optional — an invited user with no roles can still log in and use
  // anything not gated by @RequirePermissions (e.g. their own profile)
  @ApiProperty({ type: [Number], required: false })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  roleIds?: number[];

  constructor(
    firstName: string,
    lastName: string,
    phone: string,
    email: string,
    roleIds?: number[],
  ) {
    this.firstName = firstName;
    this.lastName = lastName;
    this.phone = phone;
    this.email = email;
    this.roleIds = roleIds;
  }
}
