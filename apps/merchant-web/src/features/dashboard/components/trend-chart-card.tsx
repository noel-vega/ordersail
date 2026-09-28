import type { UseQueryResult } from "@tanstack/react-query"
import type {
  DashboardSalesTimeseries,
  SalesTimeseriesPoint,
} from "merchant-sdk"
import type { ReactElement } from "react"
import { Button } from "ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "ui/card"
import { ChartContainer, type ChartConfig } from "ui/chart"
import { Skeleton } from "ui/skeleton"
import { formatBucketSpan } from "../dashboard-trend"
import type { TrendColumn } from "./trend-chart"

const TREND_CHART_HEIGHT_CLASS = "h-[220px]"

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
