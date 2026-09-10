import { ApiProperty } from '@nestjs/swagger';
import { User } from './user.entity';

export class PaginatedUsers {
  @ApiProperty({ type: () => [User] })
  items!: User[];

  @ApiProperty({ type: Number })
  total!: number;

  @ApiProperty({ type: Number })
  limit!: number;

  @ApiProperty({ type: Number })
  offset!: number;
}
