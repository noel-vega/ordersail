import type { ReactNode } from "react"
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "ui/card"
import { cn } from "ui/utils"
import { percentChange } from "../dashboard-range"

const percent = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
})

export function MetricCard(props: {
  title: string
  value: ReactNode
  // a line under the value, e.g. "Gross $X · Refunds $Y"
  detail?: ReactNode
  // vs the previous period; omitted for point-in-time metrics
  comparison?: { current: number; previous: number; previousLabel: string }
  tone?: "default" | "alert"
  interactive?: boolean
  className?: string
}) {
  return (
    <Card
      className={cn(
        "flex-1",
        props.interactive && "transition-colors hover:bg-accent",
        props.tone === "alert" && "border-destructive",
        props.className,
      )}
    >
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {props.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <div
          className={cn(
            "text-2xl font-semibold tabular-nums",
            props.tone === "alert" && "text-destructive",
          )}
        >
          {props.value}
        </div>
        {props.comparison && <Delta {...props.comparison} />}
        {props.detail && (
          <div className="text-xs text-muted-foreground tabular-nums">
            {props.detail}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ▲/▼ % vs the previous period. Arrow + sign carry the direction, so colour
// is never the only cue; "—" when the previous period was 0
function Delta(props: { current: number; previous: number; previousLabel: string }) {
  const change = percentChange(props.current, props.previous)
  const title = `vs ${props.previousLabel}`

  if (change === null) {
    return (
      <div className="text-xs text-muted-foreground" title={title}>
        — <span className="sr-only">no change to compare</span> {title}
      </div>
    )
  }

  const up = change > 0
  const down = change < 0
  return (
    <div
      className={cn(
        "flex items-center gap-1 text-xs tabular-nums",
        up && "text-emerald-700 dark:text-emerald-400",
        down && "text-destructive",
        !up && !down && "text-muted-foreground",
      )}
      title={title}
    >
      {up && <ArrowUpIcon className="size-3" aria-hidden />}
      {down && <ArrowDownIcon className="size-3" aria-hidden />}
      <span>
        {up ? "+" : ""}
        {percent.format(change)}
      </span>
      <span className="text-muted-foreground">{title}</span>
    </div>
  )
}
