import { ApiProperty } from '@nestjs/swagger';
import { SelectLocation } from 'db/stock';

export class Location implements SelectLocation {
  @ApiProperty({ type: Number })
  id!: number;

  @ApiProperty({ type: Number })
  accountId!: number;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: 'string', nullable: true })
  addressLine1!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  addressLine2!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  addressCity!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  addressState!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  addressPostalCode!: string | null;

  // US-only for now (OS-689) — never null, even on a stock-only location
  @ApiProperty({ type: 'string', example: 'US' })
  addressCountry!: string;

  // E.164 — see locationsTable.phone
  @ApiProperty({ type: 'string', nullable: true, example: '+12015550123' })
  phone!: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
