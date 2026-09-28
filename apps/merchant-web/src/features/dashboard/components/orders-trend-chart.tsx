import type { UseQueryResult } from "@tanstack/react-query"
import type { DashboardSalesTimeseries } from "merchant-sdk"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { ChartTooltip, type ChartConfig } from "ui/chart"
import { hasNoOrders } from "../dashboard-trend"
import { TrendChartCard } from "./trend-chart-card"
import {
  TREND_CHART_MARGIN,
  bucketXAxisProps,
  trendTooltipContent,
  type TrendColumn,
} from "./trend-chart"

const config = {
  orderCount: { label: "Orders", color: "var(--chart-1)" },
} satisfies ChartConfig

const columns: TrendColumn[] = [
  {
    label: "Orders",
    value: (p) => p.orderCount.toLocaleString("en-US"),
    colorVar: "var(--color-orderCount)",
  },
]

// Orders per bucket (OS-194): a count, so bars from a zero baseline. Bars are
// capped at 24px so a 7-day range doesn't draw slabs; the hover band covers
// the whole slot, so a short bar is still easy to hit.
export function OrdersTrendChart(props: {
  query: UseQueryResult<DashboardSalesTimeseries>
}) {
  return (
    <TrendChartCard
      title="Orders"
      query={props.query}
      config={config}
      columns={columns}
      isEmpty={hasNoOrders}
      emptyMessage="No orders in this period"
    >
      {(series, empty) => (
        <BarChart data={series.points} margin={TREND_CHART_MARGIN}>
          <CartesianGrid vertical={false} />
          <XAxis {...bucketXAxisProps(series)} />
          <YAxis
            width={40}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            ticks={empty ? [0] : undefined}
          />
          <ChartTooltip content={trendTooltipContent(series, columns)} />
          <Bar
            dataKey="orderCount"
            fill="var(--color-orderCount)"
            radius={[4, 4, 0, 0]}
            maxBarSize={24}
            isAnimationActive={false}
          />
        </BarChart>
      )}
    </TrendChartCard>
  )
}
