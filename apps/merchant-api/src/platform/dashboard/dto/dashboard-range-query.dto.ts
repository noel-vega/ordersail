import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { RANGE_PRESETS, type RangePreset } from '../range';

// `?from&to` for every range-scoped dashboard endpoint. Local calendar dates
// in the account's timezone, both inclusive; parsed and bounded by
// resolveRange (which 400s), so only the shape is checked here.
export class DashboardRangeQueryDto {
  @ApiProperty({
    required: false,
    example: '2026-09-01',
    description: 'first day (YYYY-MM-DD); default: 29 days before `to`',
  })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiProperty({
    required: false,
    example: '2026-09-30',
    description: "last day (YYYY-MM-DD); default: today in the account's zone",
  })
  @IsOptional()
  @IsString()
  to?: string;

  @ApiProperty({
    required: false,
    enum: RANGE_PRESETS,
    description:
      "window length ending at `to` (default today in the account's zone) when `from` is omitted; default 30d",
  })
  @IsOptional()
  @IsIn(RANGE_PRESETS)
  range?: RangePreset;
}
