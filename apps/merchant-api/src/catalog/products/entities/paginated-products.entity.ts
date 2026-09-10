import { ApiProperty } from '@nestjs/swagger';
import { Product } from './product.entity';

export class PaginatedProducts {
  @ApiProperty({ type: () => [Product] })
  items!: Product[];

  @ApiProperty({ type: Number })
  total!: number;

  @ApiProperty({ type: Number })
  limit!: number;

  @ApiProperty({ type: Number })
  offset!: number;
}
