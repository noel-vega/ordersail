import { addDays, endOfMonth, format } from "date-fns"
import type { SalesTimeseriesPoint } from "merchant-sdk"
import { formatRangeLabel, fromLocalDate, toLocalDate } from "./dashboard-range"

// Formatting for the trend charts (OS-194). Bucket dates are local calendar
// dates in the account's timezone, and the API picks the granularity from the
// range's span (OS-670): ≤ 31 days → day, ≤ 184 → week (Monday start), else
// month.
export type Granularity = "day" | "week" | "month"

// X-axis tick: "Sep 3" · "Wk of Sep 1" · "Sep 2026"
export function formatBucketTick(
  date: string,
  granularity: Granularity,
): string {
  const day = toLocalDate(date)
  if (granularity === "day") return format(day, "MMM d")
  if (granularity === "week") return `Wk of ${format(day, "MMM d")}`
  return format(day, "MMM yyyy")
}

// Tooltip heading: the days the bucket actually counts. The first and last
// buckets can be partial: a range starting on a Thursday has a first week
// dated the Monday before, but only its in-range days hold sales. So the week
// or month is clamped to the range: "Sep 3 – 6, 2026", not "Aug 31 – Sep 6".
export function formatBucketSpan(
  date: string,
  granularity: Granularity,
  range?: { from: string; to: string },
): string {
  if (granularity === "day")
    return format(toLocalDate(date), "EEE, MMM d, yyyy")
  const start = toLocalDate(date)
  const end = granularity === "week" ? addDays(start, 6) : endOfMonth(start)
  // YYYY-MM-DD strings compare in date order
  const from = range && range.from > date ? range.from : date
  const lastDay = fromLocalDate(end)
  const to = range && range.to < lastDay ? range.to : lastDay
  return formatRangeLabel(from, to)
}

const compactCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  // currency's default minimum of 2 would pad $950 to $950.0
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
})

// Y-axis tick: $0 · $950 · $1.2K · $3.4M
export function formatCompactCents(cents: number): string {
  return compactCurrency.format(cents / 100)
}

// no sales at all: every bucket is zero, refunds included, so there is
// nothing to draw (a refund-only period is not empty — its net is negative)
export function hasNoSales(points: SalesTimeseriesPoint[]): boolean {
  return points.every((p) => p.grossSalesCents === 0 && p.refundsCents === 0)
}

export function hasNoOrders(points: SalesTimeseriesPoint[]): boolean {
  return points.every((p) => p.orderCount === 0)
}
