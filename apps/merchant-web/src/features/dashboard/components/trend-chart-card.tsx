import type { ReactNode } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "ui/card"
import { Skeleton } from "ui/skeleton"

export const TREND_CHART_HEIGHT = "h-[220px]"

// The frame both trend charts share (OS-194): title, a skeleton at the chart's
// height on first load, and an "empty" note over the flat axis when there is
// nothing to draw. The chart itself always renders once data is in, so an
// empty period still shows its dates rather than a blank box.
export function TrendChartCard(props: {
  title: string
  loading: boolean
  empty: boolean
  emptyMessage: string
  // the same values as a screen-reader table — the chart's hover tooltips
  // aren't reachable without a pointer
  table: ReactNode
  children: ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {props.title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {props.loading ? (
          <Skeleton className={`${TREND_CHART_HEIGHT} w-full`} />
        ) : (
          <div className="relative">
            {props.children}
            {props.empty && (
              <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                {props.emptyMessage}
              </p>
            )}
            {props.table}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// A tooltip body: heading, then value-first rows keyed by a short line in the
// series colour (the plotted measure) or no key (supporting figures)
export function TrendTooltip(props: {
  heading: string
  rows: { label: string; value: string; colorVar?: string }[]
}) {
  return (
    <div className="grid min-w-40 gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{props.heading}</div>
      {props.rows.map((row) => (
        <div key={row.label} className="flex items-center gap-2">
          <span
            aria-hidden
            className="h-0.5 w-3 shrink-0 rounded-full"
            style={{ background: row.colorVar ?? "transparent" }}
          />
          <span className="text-muted-foreground">{row.label}</span>
          <span className="ml-auto font-mono font-medium tabular-nums text-foreground">
            {row.value}
          </span>
        </div>
      ))}
    </div>
  )
}
