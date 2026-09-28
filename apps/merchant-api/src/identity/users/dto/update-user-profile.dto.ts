import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength, ValidateIf } from 'class-validator';
import { IsE164Phone } from 'src/shared/validation/is-e164-phone';

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
  //
  // A number that's set is validated and stored as E.164 (OS-687). The
  // ValidateIf lets a blank string through as the "clear" it means; anything
  // else, non-strings included, still has to be a real number.
  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    example: '+12015550123',
  })
  @IsOptional()
  @ValidateIf(
    (o: UpdateUserProfileDto) =>
      typeof o.phone !== 'string' || o.phone.trim() !== '',
  )
  @IsE164Phone()
  phone?: string | null;

  constructor(firstName?: string, lastName?: string, phone?: string | null) {
    this.firstName = firstName;
    this.lastName = lastName;
    this.phone = phone;
  }
}
