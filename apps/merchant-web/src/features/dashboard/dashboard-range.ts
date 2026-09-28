import { z } from "zod"
import { format } from "date-fns"
import type { DashboardRangeParams } from "merchant-sdk"

// The dashboard's reporting range (OS-193), kept in the URL: a preset
// (`?range=7d`) or a custom span (`?from=2026-09-01&to=2026-09-30`). Dates are
// local calendar dates in the ACCOUNT's timezone, both inclusive. Presets are
// resolved by the API — only it can know the account's "today" for a role
// without account:read — and the response's `range` carries the dates back.

export const RANGE_PRESETS = ["today", "7d", "30d", "90d", "12m"] as const
export type RangePreset = (typeof RANGE_PRESETS)[number]

export const DEFAULT_PRESET: RangePreset = "30d"

export const PRESET_LABELS: Record<RangePreset, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "12m": "Last 12 months",
}

// matches the API's MAX_RANGE_DAYS (platform/dashboard/range.ts)
export const MAX_RANGE_DAYS = 731

const DAY_MS = 24 * 60 * 60 * 1000

// calendar-date arithmetic is timezone-free; a date is pinned to UTC
// midnight only so Date can count days. NaN for an impossible date (02-30)
function parseDate(value: string): number {
  const ms = Date.parse(`${value}T00:00:00Z`)
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value
    ? ms
    : NaN
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => !Number.isNaN(parseDate(value)))

export const dashboardSearchSchema = z.object({
  range: z.enum(RANGE_PRESETS).optional().catch(undefined),
  from: isoDate.optional().catch(undefined),
  to: isoDate.optional().catch(undefined),
})
export type DashboardSearch = z.infer<typeof dashboardSearchSchema>

// inclusive day count, 0 or less when reversed
export function rangeDays(from: string, to: string): number {
  return (parseDate(to) - parseDate(from)) / DAY_MS + 1
}

// The API params for what the URL asks for, and which preset (or "custom")
// the picker should show as selected. A custom span only counts when it's
// complete and valid — otherwise fall back to the preset rather than let the
// API 400 the whole dashboard over a hand-edited URL.
export function toApiRange(search: DashboardSearch): {
  params: DashboardRangeParams
  preset: RangePreset | "custom"
} {
  const { from, to } = search
  if (from && to) {
    const days = rangeDays(from, to)
    if (days >= 1 && days <= MAX_RANGE_DAYS) {
      return { params: { from, to }, preset: "custom" }
    }
  }
  const preset = search.range ?? DEFAULT_PRESET
  return { params: { range: preset }, preset }
}

// YYYY-MM-DD <-> a local Date at midnight, for the calendar. The Date is only
// a vehicle for the calendar day — its timezone is irrelevant
export function toLocalDate(date: string): Date {
  const [y, m, d] = date.split("-").map(Number)
  return new Date(y, m - 1, d)
}

export function fromLocalDate(date: Date): string {
  return format(date, "yyyy-MM-dd")
}

// "Sep 27, 2026" · "Sep 1 – 30, 2026" · "Aug 29 – Sep 27, 2026" ·
// "Dec 1, 2025 – Jan 5, 2026"
export function formatRangeLabel(from: string, to: string): string {
  const a = toLocalDate(from)
  const b = toLocalDate(to)
  if (from === to) return format(a, "MMM d, yyyy")
  if (a.getFullYear() !== b.getFullYear()) {
    return `${format(a, "MMM d, yyyy")} – ${format(b, "MMM d, yyyy")}`
  }
  if (a.getMonth() === b.getMonth()) {
    return `${format(a, "MMM d")} – ${format(b, "d, yyyy")}`
  }
  return `${format(a, "MMM d")} – ${format(b, "MMM d, yyyy")}`
}

// change vs the previous period as a fraction (0.25 = +25%); null when
// there's nothing to compare against (previous 0) — a % of zero is undefined
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null
  return (current - previous) / Math.abs(previous)
}
