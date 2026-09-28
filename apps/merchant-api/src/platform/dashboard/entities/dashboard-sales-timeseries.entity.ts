import { ApiProperty } from '@nestjs/swagger';

export const SALES_GRANULARITIES = ['day', 'week', 'month'] as const;
export type SalesGranularity = (typeof SALES_GRANULARITIES)[number];

// One bucket of GET /dashboard/sales/timeseries (OS-670). The money follows
// SalesTotals' definitions; summed over every point it equals
// GET /dashboard/sales `current` for the same range.
export class SalesTimeseriesPoint {
  @ApiProperty({
    example: '2026-09-07',
    description:
      "the bucket's first local date (YYYY-MM-DD) — a week starts Monday. The first and last buckets may extend past the range; only in-range sales are counted",
  })
  date!: string;

  @ApiProperty({ type: Number })
  grossSalesCents!: number;

  @ApiProperty({ type: Number })
  refundsCents!: number;

  @ApiProperty({ type: Number })
  netSalesCents!: number;

  @ApiProperty({ type: Number })
  orderCount!: number;
}

export class DashboardSalesTimeseries {
  @ApiProperty({
    enum: SALES_GRANULARITIES,
    description:
      'chosen from the span: ≤ 31 days → day, ≤ 184 days → week, else month',
  })
  granularity!: SalesGranularity;

  @ApiProperty({ example: 'America/New_York' })
  timezone!: string;

  // every bucket in the range, zero-filled, oldest first
  @ApiProperty({ type: [SalesTimeseriesPoint] })
  points!: SalesTimeseriesPoint[];
}
