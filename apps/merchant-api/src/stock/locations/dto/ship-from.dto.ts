import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { IsE164Phone } from 'src/shared/validation/is-e164-phone';

// the fields that make a location a ship-from origin: the address a carrier
// picks up from and the contact it reaches there. All optional — a
// stock-only location needs none of them — but a label can't be bought from
// a location until it has an address and a phone (OS-688)
export const SUPPORTED_COUNTRIES = ['US'] as const;

export class ShipFromDto {
  @ApiProperty({ type: 'string', required: false, nullable: true })
  @IsOptional()
  @IsString()
  addressLine1?: string | null;

  @ApiProperty({ type: 'string', required: false, nullable: true })
  @IsOptional()
  @IsString()
  addressLine2?: string | null;

  @ApiProperty({ type: 'string', required: false, nullable: true })
  @IsOptional()
  @IsString()
  addressCity?: string | null;

  @ApiProperty({ type: 'string', required: false, nullable: true })
  @IsOptional()
  @IsString()
  addressState?: string | null;

  @ApiProperty({ type: 'string', required: false, nullable: true })
  @IsOptional()
  @IsString()
  addressPostalCode?: string | null;

  // US-only for now: anything else is refused, and the location is stored
  // as US whether or not this is sent (LocationsService)
  @ApiProperty({ enum: SUPPORTED_COUNTRIES, required: false })
  @IsOptional()
  @IsIn(SUPPORTED_COUNTRIES)
  addressCountry?: (typeof SUPPORTED_COUNTRIES)[number];

  // stored as E.164; null clears it
  @ApiProperty({
    type: 'string',
    required: false,
    nullable: true,
    example: '+12015550123',
  })
  @IsOptional()
  @IsE164Phone()
  phone?: string | null;
}
