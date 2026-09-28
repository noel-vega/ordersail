import { queryOptions, useMutation, useQuery } from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"
import { queryClient } from "../../lib/react-query-client"
import { getDashboardSummaryQueryOptions } from "../dashboard/dashboard.hooks"

export function getAccountQueryOptions() {
  return queryOptions({
    queryKey: ["account"],
    queryFn: () => merchantApi.account.get(),
  })
}

export function useAccountQuery() {
  return useQuery(getAccountQueryOptions())
}

export function useUpdateAccountMutation() {
  return useMutation({
    mutationFn: (params: Parameters<typeof merchantApi.account.update>[0]) =>
      merchantApi.account.update(params),
    onSuccess: () => {
      queryClient.invalidateQueries(getAccountQueryOptions())
      // the ["dashboard"] prefix: the stock counts and low-stock list follow
      // lowStockThreshold, the sales figures follow timezone (OS-195)
      queryClient.invalidateQueries(getDashboardSummaryQueryOptions())
    },
  })
}
