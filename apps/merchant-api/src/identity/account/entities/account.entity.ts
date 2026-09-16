import { ApiProperty } from '@nestjs/swagger';
import { SelectAccount } from 'db/identity';

export class Account implements SelectAccount {
  @ApiProperty({ type: Number })
  id!: number;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  phone!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty({ type: Date, nullable: true })
  requireMfaAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
