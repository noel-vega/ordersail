import { ApiProperty } from '@nestjs/swagger';
import { PaginatedProducts } from '../../products/entities/paginated-products.entity';

export class CategoryDetail {
  @ApiProperty({ type: Number })
  id!: number;

  @ApiProperty()
  name!: string;

  // active products in this category, paginated the same way GET /products is
  @ApiProperty({ type: () => PaginatedProducts })
  products!: PaginatedProducts;
}
