import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class CreateApiKeyDto {
  // optional human label so a merchant can tell keys apart on the
  // Developers screen — the key itself works with or without it
  @ApiProperty({ required: false, nullable: true, type: String })
  @IsOptional()
  @IsString()
  label?: string | null;
}
