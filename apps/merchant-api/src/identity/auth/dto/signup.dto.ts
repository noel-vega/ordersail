import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { IsStrongPassword } from 'password-policy';

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
