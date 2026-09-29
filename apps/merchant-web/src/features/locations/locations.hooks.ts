import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
} from "@tanstack/react-query"
import type { Location } from "merchant-sdk"
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

// The location a variant's stock lives at until there's a picker: the lowest
// id, the same one the API puts opening stock in (products.service
// openingStockLocationId). Not the list's first item — the list sorts by name,
// so a rename would silently move it. `location` is undefined both while
// loading and when the account has none (OS-689); `isLoaded` tells them apart.
// Used on product pages, which need only products:read — so without
// locations:read it doesn't fetch (no 403, OS-672) and stays not-loaded.
export function useStockLocation() {
  const canReadLocations = usePermissions().has("locations:read")
  const locations = useQuery({
    ...getListLocationsQueryOptions(),
    enabled: canReadLocations,
  })
  const location = locations.data?.items.reduce<Location | undefined>(
    (lowest, l) => (!lowest || l.id < lowest.id ? l : lowest),
    undefined,
  )
  return { location, isLoaded: locations.isSuccess }
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
