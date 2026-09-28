import type { UseQueryResult } from "@tanstack/react-query"
import type { DashboardSalesTimeseries } from "merchant-sdk"
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts"
import { ChartTooltip, type ChartConfig } from "ui/chart"
import { formatCents, formatCompactCents } from "../../../lib/currency"
import { hasNoSales } from "../dashboard-trend"
import { TrendChartCard } from "./trend-chart-card"
import {
  TREND_CHART_MARGIN,
  bucketXAxisProps,
  trendTooltipContent,
  type TrendColumn,
} from "./trend-chart"

const config = {
  netSalesCents: { label: "Net sales", color: "var(--chart-1)" },
} satisfies ChartConfig

const columns: TrendColumn[] = [
  {
    label: "Net sales",
    value: (p) => formatCents(p.netSalesCents),
    colorVar: "var(--color-netSalesCents)",
  },
  { label: "Gross", value: (p) => formatCents(p.grossSalesCents) },
  { label: "Refunds", value: (p) => formatCents(p.refundsCents) },
]

// Net sales per bucket (OS-194). An area — one series over time — with a
// linear curve, so a smoothed spline can't dip below zero between points that
// don't. A refund-heavy bucket's negative net is drawn below the zero line,
// not clamped.
export function SalesTrendChart(props: {
  query: UseQueryResult<DashboardSalesTimeseries>
}) {
  return (
    <TrendChartCard
      title="Net sales"
      query={props.query}
      config={config}
      columns={columns}
      isEmpty={hasNoSales}
      emptyMessage="No sales in this period"
    >
      {(series, empty) => (
        <AreaChart data={series.points} margin={TREND_CHART_MARGIN}>
          <CartesianGrid vertical={false} />
          <XAxis {...bucketXAxisProps(series)} />
          <YAxis
            width={56}
            tickLine={false}
            axisLine={false}
            tickFormatter={formatCompactCents}
            // an all-zero domain would get fractional-cent ticks that all
            // read "$0" — draw just the one zero line
            ticks={empty ? [0] : undefined}
          />
          {series.points.some((p) => p.netSalesCents < 0) && (
            <ReferenceLine
              y={0}
              stroke="var(--muted-foreground)"
              strokeWidth={1}
            />
          )}
          <ChartTooltip
            cursor={{ strokeWidth: 1 }}
            content={trendTooltipContent(series, columns)}
          />
          <Area
            dataKey="netSalesCents"
            type="linear"
            baseValue={0}
            stroke="var(--color-netSalesCents)"
            strokeWidth={2}
            fill="var(--color-netSalesCents)"
            fillOpacity={0.1}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
            isAnimationActive={false}
          />
        </AreaChart>
      )}
    </TrendChartCard>
  )
}
