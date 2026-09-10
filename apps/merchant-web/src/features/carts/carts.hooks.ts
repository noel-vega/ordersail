import { queryOptions, useQuery } from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"

export function getListCartsQueryOptions() {
  return queryOptions({
    queryKey: ["carts"],
    queryFn: () => merchantApi.carts.list(),
  })
}

export function useListCartsQuery() {
  return useQuery(getListCartsQueryOptions())
}

export function getCartQueryOptions(id: number) {
  return queryOptions({
    queryKey: ["carts", id],
    queryFn: () => merchantApi.carts.getById(id),
  })
}

export function useCartQuery(id: number) {
  return useQuery(getCartQueryOptions(id))
}
