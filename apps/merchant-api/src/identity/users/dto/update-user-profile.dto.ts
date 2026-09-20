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

  // Nullable where the names aren't: a phone number is genuinely optional on
  // the row, so "I no longer have one" has to be expressible. The three
  // states stay distinct — absent leaves the column alone, null or an empty
  // string clears it to NULL, anything else sets it.
  @ApiProperty({ required: false, type: String, nullable: true })
  @IsOptional()
  @IsString()
  phone?: string | null;

  constructor(firstName?: string, lastName?: string, phone?: string | null) {
    this.firstName = firstName;
    this.lastName = lastName;
    this.phone = phone;
  }
}
