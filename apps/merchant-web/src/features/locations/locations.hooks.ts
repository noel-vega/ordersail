import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
} from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"
import { queryClient } from "../../lib/react-query-client"
import { PAGE_SIZE, pageOffset, type ListSearch } from "../../lib/list-search"

// No `search` → the full list (capped at 100) for the location pickers. With a
// `search` → one page for the Locations list route.
export function getListLocationsQueryOptions(search?: ListSearch) {
  return queryOptions({
    queryKey: ["locations", search ?? "all"],
    queryFn: () =>
      merchantApi.locations.list(
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

export function useListLocationsQuery(search?: ListSearch) {
  return useQuery(getListLocationsQueryOptions(search))
}

export function useCreateLocationMutation() {
  return useMutation({
    mutationFn: merchantApi.locations.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["locations"] })
    },
  })
}

export function useUpdateLocationMutation() {
  return useMutation({
    mutationFn: ({
      id,
      ...params
    }: { id: number } & Parameters<typeof merchantApi.locations.update>[1]) =>
      merchantApi.locations.update(id, params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["locations"] })
    },
  })
}
