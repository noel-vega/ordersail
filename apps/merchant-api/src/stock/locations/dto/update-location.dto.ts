import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { IsE164Phone } from 'src/shared/validation/is-e164-phone';

export class UpdateLocationDto {
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

  @ApiProperty({ type: 'string', required: false, nullable: true })
  @IsOptional()
  @IsString()
  addressCountry?: string | null;

  // the contact a carrier reaches at this origin — required to buy a label
  // from here. Stored as E.164; null clears it (OS-688)
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
