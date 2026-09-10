import { queryOptions, useMutation, useQuery } from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"
import { queryClient } from "../../lib/react-query-client"

type InventoryListParams = { productId?: number; locationId?: number }

export function getListInventoryQueryOptions(params: InventoryListParams = {}) {
  return queryOptions({
    queryKey: ["inventory", params],
    queryFn: () => merchantApi.inventory.list({ limit: 100, ...params }),
  })
}

export function useListInventoryQuery(params?: InventoryListParams) {
  return useQuery(getListInventoryQueryOptions(params))
}

export function getListInventoryMovementsQueryOptions() {
  return queryOptions({
    queryKey: ["inventory", "movements"],
    queryFn: () => merchantApi.inventory.movements.list(),
  })
}

export function useListInventoryMovementsQuery() {
  return useQuery(getListInventoryMovementsQueryOptions())
}

export function useCreateInventoryMovementMutation() {
  return useMutation({
    mutationFn: merchantApi.inventory.movements.create,
    onSuccess: () => {
      // every inventory query (list, movements, product-scoped) shares the
      // "inventory" key prefix
      queryClient.invalidateQueries({ queryKey: ["inventory"] })
      // a variant's derived stock (shown on the product page) lives off the
      // same inventory rows a movement just changed
      queryClient.invalidateQueries({ queryKey: ["products"] })
    },
  })
}
