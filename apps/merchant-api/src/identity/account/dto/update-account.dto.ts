import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

// the shipping contact used as the addressFrom phone/email for every
// Shippo label purchase, regardless of which location ships the order
export class UpdateAccountDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  phone?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  email?: string;

  // toggles accountsTable.requireMfaAt (OS-473) — true sets it to now,
  // false clears it. Omitted leaves the current setting untouched.
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  requireMfa?: boolean;
}
