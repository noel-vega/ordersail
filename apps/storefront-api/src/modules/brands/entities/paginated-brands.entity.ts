import { ApiProperty } from '@nestjs/swagger';
import { Brand } from './brand.entity';

export class PaginatedBrands {
  @ApiProperty({ type: () => [Brand] })
  items!: Brand[];

  @ApiProperty({ type: Number })
  total!: number;

  @ApiProperty({ type: Number })
  limit!: number;

  @ApiProperty({ type: Number })
  offset!: number;
}
