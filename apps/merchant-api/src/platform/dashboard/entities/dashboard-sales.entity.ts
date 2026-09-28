import { ApiProperty } from '@nestjs/swagger';

// Money figures for one reporting window (OS-669). See
// DashboardService.getSalesTotals for the exact definitions.
export class SalesTotals {
  @ApiProperty({
    type: Number,
    description: 'SUM(amountTotalCents) of paid orders placed in the window',
  })
  grossSalesCents!: number;

  @ApiProperty({
    type: Number,
    description: 'refunds issued in the window, as a positive amount',
  })
  refundsCents!: number;

  @ApiProperty({ type: Number, description: 'grossSalesCents − refundsCents' })
  netSalesCents!: number;

  @ApiProperty({ type: Number })
  orderCount!: number;

  @ApiProperty({
    type: Number,
    description: 'grossSalesCents / orderCount, rounded; 0 with no orders',
  })
  averageOrderValueCents!: number;
}

export class DashboardSalesRange {
  // local calendar dates (YYYY-MM-DD) in `timezone`, both inclusive
  @ApiProperty({ example: '2026-09-01' })
  from!: string;

  @ApiProperty({ example: '2026-09-30' })
  to!: string;

  @ApiProperty({ example: '2026-08-02' })
  previousFrom!: string;

  @ApiProperty({ example: '2026-08-31' })
  previousTo!: string;

  @ApiProperty({ example: 'America/New_York' })
  timezone!: string;
}

export class DashboardSales {
  @ApiProperty({ type: DashboardSalesRange })
  range!: DashboardSalesRange;

  @ApiProperty({ type: SalesTotals })
  current!: SalesTotals;

  // the equal-length window immediately before `current`
  @ApiProperty({ type: SalesTotals })
  previous!: SalesTotals;
}
