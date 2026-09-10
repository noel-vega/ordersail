import { queryOptions, useQuery } from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"

export function getListApiKeysQueryOptions() {
  return queryOptions({
    queryKey: ["api-keys"],
    queryFn: merchantApi.apiKeys.list,
  })
}

export function useListApiKeysQuery() {
  return useQuery(getListApiKeysQueryOptions())
}
