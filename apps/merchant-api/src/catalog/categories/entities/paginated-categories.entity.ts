import { ApiProperty } from '@nestjs/swagger';
import { CategoryListItem } from './category-list-item.entity';

export class PaginatedCategories {
  @ApiProperty({ type: () => [CategoryListItem] })
  items!: CategoryListItem[];

  @ApiProperty({ type: Number })
  total!: number;

  @ApiProperty({ type: Number })
  limit!: number;

  @ApiProperty({ type: Number })
  offset!: number;
}
