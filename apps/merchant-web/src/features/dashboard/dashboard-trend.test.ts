import { describe, expect, it } from "vitest"
import {
  formatBucketSpan,
  formatBucketTick,
  hasNoOrders,
  hasNoSales,
} from "./dashboard-trend"

const point = (
  over: Partial<Parameters<typeof hasNoSales>[0][number]> = {},
) => ({
  date: "2026-09-01",
  grossSalesCents: 0,
  refundsCents: 0,
  netSalesCents: 0,
  orderCount: 0,
  ...over,
})

describe("formatBucketTick", () => {
  it.each([
    ["2026-09-03", "day", "Sep 3"],
    ["2026-08-31", "week", "Wk of Aug 31"],
    ["2026-09-01", "month", "Sep 2026"],
  ] as const)("%s by %s → %s", (date, granularity, label) => {
    expect(formatBucketTick(date, granularity)).toBe(label)
  })
})

describe("formatBucketSpan", () => {
  const series = (
    granularity: "day" | "week" | "month",
    from: string,
    to: string,
  ) => ({ granularity, from, to })

  it("a day is the full date", () => {
    expect(
      formatBucketSpan("2026-09-03", series("day", "2026-09-01", "2026-09-07")),
    ).toBe("Thu, Sep 3, 2026")
  })

  it("a whole week or month in the range", () => {
    const week = series("week", "2026-06-01", "2026-12-31")
    expect(formatBucketSpan("2026-09-07", week)).toBe("Sep 7 – 13, 2026")
    expect(formatBucketSpan("2026-08-31", week)).toBe("Aug 31 – Sep 6, 2026")
    const month = series("month", "2026-01-01", "2026-12-31")
    expect(formatBucketSpan("2026-02-01", month)).toBe("Feb 1 – 28, 2026")
  })

  it("clamps a partial first and last bucket to the series' range", () => {
    const week = series("week", "2026-09-03", "2026-12-01")
    // the first week is dated Monday Aug 31 but starts counting on Sep 3
    expect(formatBucketSpan("2026-08-31", week)).toBe("Sep 3 – 6, 2026")
    expect(formatBucketSpan("2026-11-30", week)).toBe("Nov 30 – Dec 1, 2026")
    expect(
      formatBucketSpan(
        "2026-01-01",
        series("month", "2026-01-15", "2027-01-10"),
      ),
    ).toBe("Jan 15 – 31, 2026")
  })
})

describe("empty checks", () => {
  it("all-zero buckets have no sales and no orders", () => {
    const points = [point(), point({ date: "2026-09-02" })]
    expect(hasNoSales(points)).toBe(true)
    expect(hasNoOrders(points)).toBe(true)
  })

  it("a refund-only period has sales to draw (negative net) but no orders", () => {
    const points = [point({ refundsCents: 500, netSalesCents: -500 })]
    expect(hasNoSales(points)).toBe(false)
    expect(hasNoOrders(points)).toBe(true)
  })
})
