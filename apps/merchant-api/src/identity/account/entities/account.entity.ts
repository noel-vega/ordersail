import { ApiProperty } from '@nestjs/swagger';
import { SelectAccount } from 'db/identity';

export class Account implements SelectAccount {
  @ApiProperty({ type: Number })
  id!: number;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty({ type: Date, nullable: true })
  requireMfaAt!: Date | null;

  // IANA zone name — see accountsTable.timezone
  @ApiProperty({ example: 'America/New_York' })
  timezone!: string;

  // see accountsTable.lowStockThreshold
  @ApiProperty({ type: Number, example: 5 })
  lowStockThreshold!: number;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
