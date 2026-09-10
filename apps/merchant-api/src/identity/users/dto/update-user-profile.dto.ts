import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

// name + phone only — email is the login identity and is never changed here
// (see OS-184). Every field optional: a PATCH may touch just one.
export class UpdateUserProfileDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  firstName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  lastName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  phone?: string;

  constructor(firstName?: string, lastName?: string, phone?: string) {
    this.firstName = firstName;
    this.lastName = lastName;
    this.phone = phone;
  }
}
