import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { IsTimeZone } from 'src/shared/validation/is-time-zone';

export class UpdateAccountDto {
  // the shipping contact email given as addressFrom.email on every Shippo
  // label, whichever location ships. The phone is per location (OS-688).
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

  // IANA zone the dashboard's reporting days are cut in (OS-667)
  @ApiProperty({ required: false, example: 'America/New_York' })
  @IsOptional()
  @IsTimeZone()
  timezone?: string;

  // stock at or below this counts as "low" (OS-668); the column has a
  // matching >= 0 CHECK, the upper bound just keeps typos out
  @ApiProperty({ required: false, type: Number, minimum: 0, maximum: 100000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  lowStockThreshold?: number;
}
