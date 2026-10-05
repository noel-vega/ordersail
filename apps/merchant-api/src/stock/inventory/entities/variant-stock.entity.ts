import { ApiProperty } from '@nestjs/swagger';

// one of a variant's inventory rows: its on-hand quantity at one location
export class VariantLocationStock {
  @ApiProperty({ type: Number })
  locationId!: number;

  @ApiProperty()
  locationName!: string;

  @ApiProperty({ type: Number })
  stock!: number;
}

// A variant with its stock summed across every location (OS-693) — the unit
// the dashboard's out/low counts and its Low stock card judge (OS-195).
export class VariantStockRecord {
  @ApiProperty({ type: Number })
  variantId!: number;

  @ApiProperty({ type: Number })
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

  @ApiProperty({
    type: Number,
    description:
      'on hand across all locations; 0 with no inventory rows; can be negative',
  })
  stock!: number;

  @ApiProperty({
    type: () => [VariantLocationStock],
    description:
      "the inventory rows `stock` sums, by location name; a location with no row isn't listed",
  })
  locations!: VariantLocationStock[];
}

export class PaginatedVariantStock {
  @ApiProperty({ type: () => [VariantStockRecord] })
  items!: VariantStockRecord[];

  @ApiProperty({ type: Number })
  total!: number;

  @ApiProperty({ type: Number })
  limit!: number;

  @ApiProperty({ type: Number })
  offset!: number;

  @ApiProperty({
    type: Number,
    description:
      "the account's low-stock threshold — the one lowStock filtered by",
  })
  lowStockThreshold!: number;
}
