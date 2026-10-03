import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
} from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"
import { queryClient } from "../../lib/react-query-client"
import { PAGE_SIZE, pageOffset, type ListSearch } from "../../lib/list-search"
import { usePermissions } from "../auth/permission-context"

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
    // used as a filter picker on other pages (e.g. Inventory) where the user
    // may hold that page's read perm but not locations:read — degrade to an
    // empty picker instead of throwing the host page to the error boundary.
    // The Locations route itself is guarded in beforeLoad (requirePermission).
    throwOnError: false,
  })
}

export function useListLocationsQuery(search?: ListSearch) {
  return useQuery(getListLocationsQueryOptions(search))
}

// The locations a variant's stock can be placed at, for the product pages'
// stock pickers. `locations` is the capped (100) picker list, for the merchant
// to choose from, never to pick one from (OS-696); `total` is the real count,
// so "exactly one" and "more than one" hold past the cap. Product pages need
// only products:read — so without locations:read it doesn't fetch (no 403,
// OS-672) and `canRead` is false; `isLoaded` tells loading from loaded.
export function useStockLocations() {
  const canRead = usePermissions().has("locations:read")
  const query = useQuery({
    ...getListLocationsQueryOptions(),
    enabled: canRead,
  })
  return {
    canRead,
    isLoaded: query.isSuccess,
    locations: query.data?.items ?? [],
    total: query.data?.total ?? 0,
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
