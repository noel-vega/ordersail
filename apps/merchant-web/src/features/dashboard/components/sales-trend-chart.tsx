import type {
  DashboardSalesTimeseries,
  SalesTimeseriesPoint,
} from "merchant-sdk"
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts"
import { ChartContainer, ChartTooltip, type ChartConfig } from "ui/chart"
import { formatCents } from "../../../lib/currency"
import {
  formatBucketSpan,
  formatBucketTick,
  formatCompactCents,
  hasNoSales,
} from "../dashboard-trend"
import {
  TREND_CHART_HEIGHT,
  TrendChartCard,
  TrendTooltip,
} from "./trend-chart-card"

const config = {
  netSalesCents: { label: "Net sales", color: "var(--chart-1)" },
} satisfies ChartConfig

type Range = { from: string; to: string }

// Net sales per bucket (OS-194). An area — one series over time — with a
// linear curve, so a smoothed spline can't dip below zero between points that
// don't. A refund-heavy bucket's negative net is drawn below the zero line,
// not clamped.
export function SalesTrendChart(props: {
  series?: DashboardSalesTimeseries
  range?: Range
}) {
  const { series, range } = props
  const points = series?.points ?? []
  const hasNegative = points.some((p) => p.netSalesCents < 0)
  const empty = hasNoSales(points)

  return (
    <TrendChartCard
      title="Net sales"
      loading={!series}
      empty={empty}
      emptyMessage="No sales in this period"
      table={series && <SalesTable series={series} range={range} />}
    >
      {series && (
        <ChartContainer
          config={config}
          className={`aspect-auto ${TREND_CHART_HEIGHT} w-full`}
        >
          <AreaChart
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
              width={56}
              tickLine={false}
              axisLine={false}
              tickFormatter={formatCompactCents}
              // an all-zero domain would get fractional-cent ticks that all
              // read "$0" — draw just the one zero line
              ticks={empty ? [0] : undefined}
            />
            {hasNegative && (
              <ReferenceLine
                y={0}
                stroke="var(--muted-foreground)"
                strokeWidth={1}
              />
            )}
            <ChartTooltip
              cursor={{ strokeWidth: 1 }}
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
                        label: "Net sales",
                        value: formatCents(point.netSalesCents),
                        colorVar: "var(--color-netSalesCents)",
                      },
                      {
                        label: "Gross",
                        value: formatCents(point.grossSalesCents),
                      },
                      {
                        label: "Refunds",
                        value: formatCents(point.refundsCents),
                      },
                    ]}
                  />
                )
              }}
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
        </ChartContainer>
      )}
    </TrendChartCard>
  )
}

function SalesTable(props: {
  series: DashboardSalesTimeseries
  range?: Range
}) {
  return (
    <table className="sr-only">
      <caption>Net sales by {props.series.granularity}</caption>
      <thead>
        <tr>
          <th scope="col">Period</th>
          <th scope="col">Net sales</th>
          <th scope="col">Gross</th>
          <th scope="col">Refunds</th>
        </tr>
      </thead>
      <tbody>
        {props.series.points.map((p) => (
          <tr key={p.date}>
            <th scope="row">
              {formatBucketSpan(p.date, props.series.granularity, props.range)}
            </th>
            <td>{formatCents(p.netSalesCents)}</td>
            <td>{formatCents(p.grossSalesCents)}</td>
            <td>{formatCents(p.refundsCents)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
