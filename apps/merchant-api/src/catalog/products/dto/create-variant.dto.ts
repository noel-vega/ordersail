import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

// e.g. { name: "Color", values: ["Red", "Blue"] }
export class VariantOptionInputDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  values!: string[];
}

export class CreateVariantsDto {
  // one entry per option; variants are generated as the cartesian product
  // of every option's values, e.g. Color x Size -> Red/S, Red/M, Blue/S, Blue/M
  @ApiProperty({ type: [VariantOptionInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => VariantOptionInputDto)
  options!: VariantOptionInputDto[];

  @ApiProperty()
  @IsNumber()
  priceCents!: number;

  @ApiProperty({ required: false, default: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  stock: number = 0;

  // where the opening stock is held; required for stock above 0 once the
  // account has more than one location (OS-696)
  @ApiProperty({ type: Number, required: false })
  @IsOptional()
  @IsInt()
  locationId?: number;
}
