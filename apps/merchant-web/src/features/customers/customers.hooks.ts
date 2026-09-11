import {
  keepPreviousData,
  queryOptions,
  useQuery,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"
import { PAGE_SIZE, pageOffset, type ListSearch } from "../../lib/list-search"

export function getListCustomersQueryOptions(
  search: ListSearch = { page: 1, q: "" },
) {
  return queryOptions({
    queryKey: ["customers", search],
    queryFn: () =>
      merchantApi.customers.list({
        limit: PAGE_SIZE,
        offset: pageOffset(search.page),
        q: search.q || undefined,
      }),
    placeholderData: keepPreviousData,
  })
}

export function useListCustomersQuery(search: ListSearch) {
  return useQuery(getListCustomersQueryOptions(search))
}

export function getCustomerQueryOptions(id: number) {
  return queryOptions({
    queryKey: ["customers", "detail", id],
    queryFn: () => merchantApi.customers.get(id),
  })
}

export function useCustomerSuspenseQuery(id: number) {
  return useSuspenseQuery(getCustomerQueryOptions(id))
}

export function useCustomerOrdersQuery(id: number, page: number) {
  return useQuery({
    queryKey: ["customers", "detail", id, "orders", page],
    queryFn: () =>
      merchantApi.customers.getOrders(id, {
        limit: PAGE_SIZE,
        offset: pageOffset(page),
      }),
    placeholderData: keepPreviousData,
  })
}
