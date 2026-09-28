import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
import { IsStrongPassword } from 'password-policy';
import { IsTimeZone } from 'src/shared/validation/is-time-zone';

export class SignUpDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  businessName: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  firstName: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  lastName: string;

  @ApiProperty()
  @IsEmail()
  email: string;

  // the account's shipping contact, used as the addressFrom phone when
  // purchasing carrier labels — required up front by carriers like USPS
  @ApiProperty()
  @IsString()
  @MinLength(1)
  phone: string;

  @ApiProperty()
  @IsString()
  @MinLength(12)
  @IsStrongPassword(['email', 'firstName', 'lastName', 'businessName'])
  password: string;

  // the account's reporting timezone (IANA), sent by merchant-web from the
  // browser. Omitted -> 'UTC' (the column default); an unknown zone is a 400
  // rather than a silent fallback, since only our own client sends it (OS-667)
  @ApiProperty({ required: false, example: 'America/New_York' })
  @IsOptional()
  @IsTimeZone()
  timezone?: string;

  constructor(
    businessName: string,
    firstName: string,
    lastName: string,
    email: string,
    phone: string,
    password: string,
  ) {
    this.businessName = businessName;
    this.firstName = firstName;
    this.lastName = lastName;
    this.email = email;
    this.phone = phone;
    this.password = password;
  }
}
