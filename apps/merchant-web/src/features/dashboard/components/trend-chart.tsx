import type {
  DashboardSalesTimeseries,
  SalesTimeseriesPoint,
} from "merchant-sdk"
import type { XAxisProps } from "recharts"
import { formatBucketSpan, formatBucketTick } from "../dashboard-trend"

// Non-component helpers the trend charts share (OS-194): recharts props and
// the column list behind each tooltip and screen-reader table. Kept out of
// trend-chart-card.tsx so that file exports only components, which React Fast
// Refresh needs.

export const TREND_CHART_MARGIN = { top: 8, right: 8, left: 0, bottom: 0 }

// the bucket-date X axis both charts share; spread into recharts' <XAxis>,
// which has to stay a direct child of the chart
export function bucketXAxisProps(series: DashboardSalesTimeseries): XAxisProps {
  return {
    dataKey: "date",
    tickLine: false,
    axisLine: false,
    tickMargin: 8,
    minTickGap: 24,
    tickFormatter: (date: string) => formatBucketTick(date, series.granularity),
  }
}

// One figure per bucket, shown in the tooltip and the screen-reader table.
// The plotted measure carries its series colour; supporting figures don't.
export type TrendColumn = {
  label: string
  value: (point: SalesTimeseriesPoint) => string
  colorVar?: string
}

// recharts' tooltip `content` for a trend chart: the hovered bucket's span,
// then one value-first row per column
export function trendTooltipContent(
  series: DashboardSalesTimeseries,
  columns: TrendColumn[],
) {
  return function TrendTooltip(props: {
    active?: boolean
    payload?: readonly { payload?: unknown }[]
  }) {
    const point = props.payload?.[0]?.payload as
      SalesTimeseriesPoint | undefined
    if (!props.active || !point) return null
    return (
      <div className="grid min-w-40 gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
        <div className="font-medium">
          {formatBucketSpan(point.date, series)}
        </div>
        {columns.map((column) => (
          <div key={column.label} className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-0.5 w-3 shrink-0 rounded-full"
              style={{ background: column.colorVar ?? "transparent" }}
            />
            <span className="text-muted-foreground">{column.label}</span>
            <span className="ml-auto font-mono font-medium tabular-nums text-foreground">
              {column.value(point)}
            </span>
          </div>
        ))}
      </div>
    )
  }
}
