import { queryOptions, useMutation, useQuery } from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"
import { queryClient } from "../../lib/react-query-client"

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
    },
  })
}
