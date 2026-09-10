import { queryOptions, useMutation, useQuery } from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"
import { queryClient } from "../../lib/react-query-client"

export function getListInventoryQueryOptions() {
  return queryOptions({
    queryKey: ["inventory"],
    queryFn: merchantApi.inventory.list,
  })
}

export function useListInventoryQuery() {
  return useQuery(getListInventoryQueryOptions())
}

export function getListInventoryMovementsQueryOptions() {
  return queryOptions({
    queryKey: ["inventory", "movements"],
    queryFn: merchantApi.inventory.movements.list,
  })
}

export function useListInventoryMovementsQuery() {
  return useQuery(getListInventoryMovementsQueryOptions())
}

export function useCreateInventoryMovementMutation() {
  return useMutation({
    mutationFn: merchantApi.inventory.movements.create,
    onSuccess: () => {
      queryClient.invalidateQueries(getListInventoryQueryOptions())
      queryClient.invalidateQueries(getListInventoryMovementsQueryOptions())
      // a variant's derived stock (shown on the product page) lives off the
      // same inventory rows a movement just changed
      queryClient.invalidateQueries({ queryKey: ["products"] })
    },
  })
}
