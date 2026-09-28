import { ApiProperty } from '@nestjs/swagger';

// A variant whose stock, summed across every location, is at or below the
// account's lowStockThreshold (OS-195). 0 or below means out of stock.
export class LowStockItem {
  @ApiProperty()
  variantId!: number;

  @ApiProperty()
  productId!: number;

  @ApiProperty()
  productName!: string;

  @ApiProperty({ type: String, nullable: true })
  sku!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Blue / Large',
    description:
      "the variant's option values in option order; null with no options",
  })
  optionsLabel!: string | null;

  @ApiProperty({ description: 'on hand across all locations; can be negative' })
  stock!: number;
}

export class DashboardLowStock {
  // most urgent first: lowest stock, then product name
  @ApiProperty({ type: [LowStockItem] })
  items!: LowStockItem[];

  // the threshold `items` were selected with (OS-668), for their badges
  @ApiProperty({ type: Number })
  lowStockThreshold!: number;
}
