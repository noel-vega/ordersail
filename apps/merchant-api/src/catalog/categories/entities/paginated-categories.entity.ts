import { ApiProperty } from '@nestjs/swagger';
import { Category } from './category.entity';

export class PaginatedCategories {
  @ApiProperty({ type: () => [Category] })
  items!: Category[];

  @ApiProperty({ type: Number })
  total!: number;

  @ApiProperty({ type: Number })
  limit!: number;

  @ApiProperty({ type: Number })
  offset!: number;
}
