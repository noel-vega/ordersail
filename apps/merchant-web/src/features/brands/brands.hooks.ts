import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
} from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"
import { queryClient } from "../../lib/react-query-client"
import { PAGE_SIZE, pageOffset, type ListSearch } from "../../lib/list-search"

// No `search` → the full list (capped at 100) for the brand pickers. With a
// `search` → one page for the Brands list route.
export function getListBrandsQueryOptions(search?: ListSearch) {
  return queryOptions({
    queryKey: ["brands", search ?? "all"],
    queryFn: () =>
      merchantApi.brands.list(
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

export function useListBrandsQuery(search?: ListSearch) {
  return useQuery(getListBrandsQueryOptions(search))
}

export function useCreateBrandMutation() {
  return useMutation({
    mutationFn: merchantApi.brands.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["brands"] })
    },
  })
}

export function useUpdateBrandMutation() {
  return useMutation({
    mutationFn: ({
      id,
      ...params
    }: { id: number } & Parameters<typeof merchantApi.brands.update>[1]) =>
      merchantApi.brands.update(id, params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["brands"] })
    },
  })
}

export function useDeleteBrandMutation() {
  return useMutation({
    mutationFn: (id: number) => merchantApi.brands.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["brands"] })
    },
  })
}
