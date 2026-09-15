import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export const PRODUCT_SORT_BY = ['price', 'newest', 'name'] as const;
export type ProductSortBy = (typeof PRODUCT_SORT_BY)[number];

export const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

export class ListProductsQueryDto {
  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;

  @ApiPropertyOptional({
    description: 'Text search over name, SKU, and barcode',
  })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ description: 'Filter to products in this category' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  categoryId?: number;

  @ApiPropertyOptional({ description: 'Filter to products of this brand' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  brandId?: number;

  @ApiPropertyOptional({ description: 'Minimum variant price, in cents' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minPriceCents?: number;

  @ApiPropertyOptional({ description: 'Maximum variant price, in cents' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxPriceCents?: number;

  @ApiPropertyOptional({
    description: 'Only include products with at least one variant in stock',
  })
  @IsOptional()
  // a query string is always "true"/"false" — plain `Type(() => Boolean)`
  // would coerce the string "false" to `true`, so map it explicitly
  @Transform(({ value }: { value: unknown }): boolean | undefined =>
    value === undefined ? undefined : value === true || value === 'true',
  )
  @IsBoolean()
  inStock?: boolean;

  @ApiPropertyOptional({ enum: PRODUCT_SORT_BY })
  @IsOptional()
  @IsIn(PRODUCT_SORT_BY)
  sortBy?: ProductSortBy;

  @ApiPropertyOptional({ enum: SORT_DIRECTIONS, default: 'asc' })
  @IsOptional()
  @IsIn(SORT_DIRECTIONS)
  sortDir?: SortDirection;
}
