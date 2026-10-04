import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { productStatusEnum } from 'db/catalog';

export class CreateProductDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  description!: string;

  @ApiProperty()
  @IsNumber()
  priceCents!: number;

  @ApiProperty({ type: 'number' })
  @IsNumber()
  brandId!: number;

  @ApiProperty({ type: String, nullable: true })
  @IsOptional()
  sku!: string;

  @ApiProperty({ type: Number })
  @Min(0)
  stock!: number;

  // where the opening stock is held; required for stock above 0 once the
  // account has more than one location (OS-696)
  @ApiProperty({ type: Number, required: false })
  @IsOptional()
  @IsInt()
  locationId?: number;

  @ApiProperty({ enum: productStatusEnum.enumValues })
  @IsIn(productStatusEnum.enumValues)
  status!: (typeof productStatusEnum.enumValues)[number];

  @ApiProperty({ type: 'array' })
  @IsArray()
  categoryIds!: number[];

  @ApiProperty({ type: [String], required: false, default: [] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  barcodes: string[] = [];
}
