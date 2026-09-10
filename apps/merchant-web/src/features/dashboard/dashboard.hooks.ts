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
