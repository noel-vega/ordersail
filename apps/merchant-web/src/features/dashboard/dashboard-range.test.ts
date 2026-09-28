import { describe, expect, it } from "vitest"
import {
  dashboardSearchSchema,
  formatRangeLabel,
  fromLocalDate,
  percentChange,
  rangeDays,
  toApiRange,
  toLocalDate,
} from "./dashboard-range"

describe("toApiRange", () => {
  it("defaults to the 30d preset, resolved by the API", () => {
    expect(toApiRange({})).toEqual({ params: { range: "30d" }, preset: "30d" })
  })

  it("passes a preset through", () => {
    expect(toApiRange({ range: "7d" })).toEqual({
      params: { range: "7d" },
      preset: "7d",
    })
  })

  it("a complete from/to is custom, overriding any preset", () => {
    expect(
      toApiRange({ range: "7d", from: "2026-09-01", to: "2026-09-15" }),
    ).toEqual({
      params: { from: "2026-09-01", to: "2026-09-15" },
      preset: "custom",
    })
  })

  it("a single custom day is valid", () => {
    expect(toApiRange({ from: "2026-09-01", to: "2026-09-01" }).preset).toBe(
      "custom",
    )
  })

})

describe("dashboardSearchSchema", () => {
  it("drops junk instead of failing the route", () => {
    expect(
      dashboardSearchSchema.parse({
        range: "forever",
        from: "2026-02-30",
        to: "yesterday",
      }),
    ).toEqual({ range: undefined, from: undefined, to: undefined })
  })

  it.each([
    [{ range: "7d", from: "2026-09-01" }],
    [{ range: "7d", to: "2026-09-01" }],
    [{ range: "7d", from: "2026-09-15", to: "2026-09-01" }],
    [{ range: "7d", from: "2024-09-27", to: "2026-09-28" }], // 732 days
  ])("drops an incomplete / reversed / too-long custom range: %p", (s) => {
    const search = dashboardSearchSchema.parse(s)
    expect(search).toEqual({ range: "7d", from: undefined, to: undefined })
    expect(toApiRange(search)).toEqual({
      params: { range: "7d" },
      preset: "7d",
    })
  })

  it("keeps exactly the API's 731-day maximum", () => {
    expect(
      dashboardSearchSchema.parse({ from: "2024-09-28", to: "2026-09-28" }),
    ).toMatchObject({ from: "2024-09-28", to: "2026-09-28" })
  })
})

describe("rangeDays", () => {
  it("counts inclusively, across leap days", () => {
    expect(rangeDays("2026-09-01", "2026-09-01")).toBe(1)
    expect(rangeDays("2028-02-28", "2028-03-01")).toBe(3)
  })
})

describe("local date round-trip", () => {
  it("keeps the calendar day", () => {
    expect(fromLocalDate(toLocalDate("2026-11-01"))).toBe("2026-11-01")
    expect(toLocalDate("2026-09-07").getDate()).toBe(7)
  })
})

describe("formatRangeLabel", () => {
  it.each([
    ["2026-09-27", "2026-09-27", "Sep 27, 2026"],
    ["2026-09-01", "2026-09-30", "Sep 1 – 30, 2026"],
    ["2026-08-29", "2026-09-27", "Aug 29 – Sep 27, 2026"],
    ["2025-12-01", "2026-01-05", "Dec 1, 2025 – Jan 5, 2026"],
  ])("%s..%s → %s", (from, to, label) => {
    expect(formatRangeLabel(from, to)).toBe(label)
  })
})

describe("percentChange", () => {
  it("up, down, flat, and nothing to compare", () => {
    expect(percentChange(150, 100)).toBe(0.5)
    expect(percentChange(50, 100)).toBe(-0.5)
    expect(percentChange(100, 100)).toBe(0)
    expect(percentChange(100, 0)).toBeNull()
  })

  it("rounds to the displayed 0.1%, so a sliver of change is flat", () => {
    expect(percentChange(100_040, 100_000)).toBe(0)
    expect(percentChange(99_960, 100_000)).toBe(0) // 0, not -0
    expect(percentChange(100_060, 100_000)).toBe(0.001)
    expect(percentChange(1, 3)).toBe(-0.667)
  })

  it("measures against the magnitude of a negative previous (refund-heavy)", () => {
    expect(percentChange(0, -100)).toBe(1)
  })
})
