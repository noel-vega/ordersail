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
    // used as a picker on other pages (Inventory, POS devices, products) — a
    // failed load degrades to an empty picker instead of throwing the host
    // page to the error boundary
    throwOnError: false,
  })
}

export function useListLocationsQuery(search?: ListSearch) {
  return useQuery(getListLocationsQueryOptions(search))
}

// The locations a variant's stock can be placed at, for the product pages'
// stock pickers. `locations` is the capped (100) picker list, for the merchant
// to choose from, never to pick one from (OS-696). `noLocation` and
// `multiLocation` come from the real `total`, so they hold past the cap, and
// both stay false until the list has loaded.
export function useStockLocations() {
  const query = useQuery(getListLocationsQueryOptions())
  const total = query.data?.total ?? 0
  return {
    isLoaded: query.isSuccess,
    locations: query.data?.items ?? [],
    // nowhere for stock to go yet (OS-689)
    noLocation: query.isSuccess && total === 0,
    // which location holds stock is the merchant's call (OS-696)
    multiLocation: total > 1,
  }
}

export function useCreateLocationMutation() {
  return useMutation({
    mutationFn: merchantApi.locations.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["locations"] })
      // a new address can satisfy the dashboard onboarding checklist
      queryClient.invalidateQueries({ queryKey: ["onboarding"] })
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
      queryClient.invalidateQueries({ queryKey: ["onboarding"] })
    },
  })
}

export function useDeleteLocationMutation() {
  return useMutation({
    mutationFn: (id: number) => merchantApi.locations.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["locations"] })
    },
  })
}
