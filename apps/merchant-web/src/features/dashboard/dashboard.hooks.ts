import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query"
import type { DashboardRangeParams } from "merchant-sdk"
import { merchantApi } from "../../lib/merchant-api-client"

export function getDashboardSummaryQueryOptions() {
  return queryOptions({
    queryKey: ["dashboard"],
    queryFn: merchantApi.dashboard.get,
  })
}

export function useDashboardSummaryQuery() {
  return useQuery(getDashboardSummaryQueryOptions())
}

// net sales / orders / AOV for a range — a preset the API resolves in the
// account's timezone, or explicit local dates (OS-669, OS-193). Keeps the
// previous range's figures on screen while a new one loads
export function getDashboardSalesQueryOptions(
  params: DashboardRangeParams = {},
) {
  return queryOptions({
    queryKey: ["dashboard", "sales", params],
    queryFn: () => merchantApi.dashboard.sales(params),
    placeholderData: keepPreviousData,
  })
}

// the same money bucketed per day / week / month for the trend charts (OS-670,
// OS-194); both charts share this one query
export function getDashboardSalesTimeseriesQueryOptions(
  params: DashboardRangeParams = {},
) {
  return queryOptions({
    queryKey: ["dashboard", "sales", "timeseries", params],
    queryFn: () => merchantApi.dashboard.salesTimeseries(params),
    placeholderData: keepPreviousData,
  })
}
