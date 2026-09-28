import { queryOptions, useQuery } from "@tanstack/react-query"
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

// net sales / orders / AOV for local dates in the account's timezone;
// omitted -> the API's default, the last 30 days (OS-669)
export function getDashboardSalesQueryOptions(range: {
  from?: string
  to?: string
} = {}) {
  return queryOptions({
    queryKey: ["dashboard", "sales", range],
    queryFn: () => merchantApi.dashboard.sales(range),
  })
}
