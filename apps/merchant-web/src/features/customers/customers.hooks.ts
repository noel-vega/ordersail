import { queryOptions, useQuery } from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"

export function getListCustomersQueryOptions() {
  return queryOptions({
    queryKey: ["customers"],
    queryFn: () => merchantApi.customers.list(),
  })
}

export function useListCustomersQuery() {
  return useQuery(getListCustomersQueryOptions())
}
