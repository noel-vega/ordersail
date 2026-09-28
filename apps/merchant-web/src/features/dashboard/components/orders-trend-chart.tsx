import type {
  DashboardSalesTimeseries,
  SalesTimeseriesPoint,
} from "merchant-sdk"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { ChartContainer, ChartTooltip, type ChartConfig } from "ui/chart"
import {
  formatBucketSpan,
  formatBucketTick,
  hasNoOrders,
} from "../dashboard-trend"
import {
  TREND_CHART_HEIGHT,
  TrendChartCard,
  TrendTooltip,
} from "./trend-chart-card"

const config = {
  orderCount: { label: "Orders", color: "var(--chart-1)" },
} satisfies ChartConfig

type Range = { from: string; to: string }

// Orders per bucket (OS-194): a count, so bars from a zero baseline. Bars are
// capped at 24px so a 7-day range doesn't draw slabs; the hover band covers
// the whole slot, so a short bar is still easy to hit.
export function OrdersTrendChart(props: {
  series?: DashboardSalesTimeseries
  range?: Range
}) {
  const { series, range } = props
  const points = series?.points ?? []
  const empty = hasNoOrders(points)

  return (
    <TrendChartCard
      title="Orders"
      loading={!series}
      empty={empty}
      emptyMessage="No orders in this period"
      table={series && <OrdersTable series={series} range={range} />}
    >
      {series && (
        <ChartContainer
          config={config}
          className={`aspect-auto ${TREND_CHART_HEIGHT} w-full`}
        >
          <BarChart
            data={points}
            margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={24}
              tickFormatter={(date: string) =>
                formatBucketTick(date, series.granularity)
              }
            />
            <YAxis
              width={40}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
              ticks={empty ? [0] : undefined}
            />
            <ChartTooltip
              content={({ active, payload }) => {
                const point = payload?.[0]?.payload as
                  SalesTimeseriesPoint | undefined
                if (!active || !point) return null
                return (
                  <TrendTooltip
                    heading={formatBucketSpan(
                      point.date,
                      series.granularity,
                      range,
                    )}
                    rows={[
                      {
                        label: "Orders",
                        value: point.orderCount.toLocaleString("en-US"),
                        colorVar: "var(--color-orderCount)",
                      },
                    ]}
                  />
                )
              }}
            />
            <Bar
              dataKey="orderCount"
              fill="var(--color-orderCount)"
              radius={[4, 4, 0, 0]}
              maxBarSize={24}
              isAnimationActive={false}
            />
          </BarChart>
        </ChartContainer>
      )}
    </TrendChartCard>
  )
}

function OrdersTable(props: {
  series: DashboardSalesTimeseries
  range?: Range
}) {
  return (
    <table className="sr-only">
      <caption>Orders by {props.series.granularity}</caption>
      <thead>
        <tr>
          <th scope="col">Period</th>
          <th scope="col">Orders</th>
        </tr>
      </thead>
      <tbody>
        {props.series.points.map((p) => (
          <tr key={p.date}>
            <th scope="row">
              {formatBucketSpan(p.date, props.series.granularity, props.range)}
            </th>
            <td>{p.orderCount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
