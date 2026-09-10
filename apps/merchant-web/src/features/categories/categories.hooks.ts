import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
} from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"
import { queryClient } from "../../lib/react-query-client"
import { PAGE_SIZE, pageOffset, type ListSearch } from "../../lib/list-search"

// No `search` → the full list (capped at 100) for the category pickers. With a
// `search` → one page for the Categories list route.
export function getListCategoriesQueryOptions(search?: ListSearch) {
  return queryOptions({
    queryKey: ["categories", search ?? "all"],
    queryFn: () =>
      merchantApi.categories.list(
        search
          ? {
              limit: PAGE_SIZE,
              offset: pageOffset(search.page),
              q: search.q || undefined,
            }
          : { limit: 100 },
      ),
    placeholderData: keepPreviousData,
  })
}

export function useListCategoriesQuery(search?: ListSearch) {
  return useQuery(getListCategoriesQueryOptions(search))
}

export function useCreateCategoryMutation() {
  return useMutation({
    mutationFn: merchantApi.categories.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] })
    },
  })
}
