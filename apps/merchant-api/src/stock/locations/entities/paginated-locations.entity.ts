import { ApiProperty } from '@nestjs/swagger';
import { Location } from './location.entity';

export class PaginatedLocations {
  @ApiProperty({ type: () => [Location] })
  items!: Location[];

  @ApiProperty({ type: Number })
  total!: number;

  @ApiProperty({ type: Number })
  limit!: number;

  @ApiProperty({ type: Number })
  offset!: number;
}
