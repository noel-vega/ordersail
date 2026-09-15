import { ApiProperty } from '@nestjs/swagger';
import { PaginatedProducts } from '../../products/entities/paginated-products.entity';

export class BrandDetail {
  @ApiProperty({ type: Number })
  id!: number;

  @ApiProperty()
  name!: string;

  // active products of this brand, paginated the same way GET /products is
  @ApiProperty({ type: () => PaginatedProducts })
  products!: PaginatedProducts;
}
