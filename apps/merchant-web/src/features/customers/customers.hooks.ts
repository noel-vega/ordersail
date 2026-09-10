import {
  keepPreviousData,
  queryOptions,
  useQuery,
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
