import type { UseQueryResult } from "@tanstack/react-query"
import type {
  DashboardSalesTimeseries,
  SalesTimeseriesPoint,
} from "merchant-sdk"
import type { ReactElement } from "react"
import type { XAxisProps } from "recharts"
import { Button } from "ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "ui/card"
import { ChartContainer, type ChartConfig } from "ui/chart"
import { Skeleton } from "ui/skeleton"
import { formatBucketSpan, formatBucketTick } from "../dashboard-trend"

const TREND_CHART_HEIGHT_CLASS = "h-[220px]"

export const TREND_CHART_MARGIN = { top: 8, right: 8, left: 0, bottom: 0 }

// the bucket-date X axis both charts share; spread into recharts' <XAxis>,
// which has to stay a direct child of the chart
export function bucketXAxisProps(
  series: DashboardSalesTimeseries,
): XAxisProps {
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

// The frame both trend charts share (OS-194): title, a skeleton at the chart's
// height on first load, a retryable error, and an "empty" note over the flat
// axis when there is nothing to draw. The chart itself always renders once
// data is in, so an empty period still shows its dates rather than a blank
// box. Alongside it, the same values as a screen-reader table — the chart's
// hover tooltips aren't reachable without a pointer.
export function TrendChartCard(props: {
  title: string
  query: UseQueryResult<DashboardSalesTimeseries>
  config: ChartConfig
  columns: TrendColumn[]
  isEmpty: (points: SalesTimeseriesPoint[]) => boolean
  emptyMessage: string
  children: (series: DashboardSalesTimeseries, empty: boolean) => ReactElement
}) {
  const { query } = props
  const series = query.data
  const empty = series ? props.isEmpty(series.points) : false

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {props.title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {series ? (
          <div className="relative">
            <ChartContainer
              config={props.config}
              className={`aspect-auto ${TREND_CHART_HEIGHT_CLASS} w-full`}
            >
              {props.children(series, empty)}
            </ChartContainer>
            {empty && (
              <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                {props.emptyMessage}
              </p>
            )}
            <TrendTable
              caption={`${props.title} by ${series.granularity}`}
              series={series}
              columns={props.columns}
            />
          </div>
        ) : query.isError ? (
          // a failed load must not read as "no sales", nor sit on the
          // skeleton forever
          <div
            className={`flex ${TREND_CHART_HEIGHT_CLASS} flex-col items-center justify-center gap-2 rounded-md border border-dashed text-center`}
          >
            <p className="text-sm font-medium">Couldn&apos;t load this chart</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              {query.isFetching ? "Retrying..." : "Retry"}
            </Button>
          </div>
        ) : (
          <Skeleton className={`${TREND_CHART_HEIGHT_CLASS} w-full`} />
        )}
      </CardContent>
    </Card>
  )
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
      | SalesTimeseriesPoint
      | undefined
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

function TrendTable(props: {
  caption: string
  series: DashboardSalesTimeseries
  columns: TrendColumn[]
}) {
  return (
    <table className="sr-only">
      <caption>{props.caption}</caption>
      <thead>
        <tr>
          <th scope="col">Period</th>
          {props.columns.map((column) => (
            <th key={column.label} scope="col">
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {props.series.points.map((point) => (
          <tr key={point.date}>
            <th scope="row">{formatBucketSpan(point.date, props.series)}</th>
            {props.columns.map((column) => (
              <td key={column.label}>{column.value(point)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
