import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
} from "@tanstack/react-query"
import { z } from "zod"
import type { InventoryMovementRecord } from "merchant-sdk"
import { merchantApi } from "../../lib/merchant-api-client"
import { queryClient } from "../../lib/react-query-client"
import { PAGE_SIZE, pageOffset, listSearchSchema } from "../../lib/list-search"

export const MOVEMENT_REASONS: InventoryMovementRecord["reason"][] = [
  "received",
  "sold",
  "return",
  "damaged",
  "adjustment",
]

export const inventorySearchSchema = listSearchSchema.extend({
  locationId: z.number().int().optional().catch(undefined),
  lowStock: z.boolean().optional().catch(undefined),
})
export type InventorySearch = z.infer<typeof inventorySearchSchema>

export const movementsSearchSchema = z.object({
  page: z.number().int().min(1).default(1).catch(1),
  reason: z.enum(MOVEMENT_REASONS).optional().catch(undefined),
})
export type MovementsSearch = z.infer<typeof movementsSearchSchema>

// one page of the Inventory list route
export function getInventoryPageQueryOptions(search: InventorySearch) {
  return queryOptions({
    queryKey: ["inventory", "page", search],
    queryFn: () =>
      merchantApi.inventory.list({
        limit: PAGE_SIZE,
        offset: pageOffset(search.page),
        q: search.q || undefined,
        locationId: search.locationId,
        stockLte: search.lowStock ? 0 : undefined,
      }),
    placeholderData: keepPreviousData,
  })
}

export function useInventoryPageQuery(search: InventorySearch) {
  return useQuery(getInventoryPageQueryOptions(search))
}

// one page of the movement-history route
export function getMovementsPageQueryOptions(search: MovementsSearch) {
  return queryOptions({
    queryKey: ["inventory", "movements", search],
    queryFn: () =>
      merchantApi.inventory.movements.list({
        limit: PAGE_SIZE,
        offset: pageOffset(search.page),
        reason: search.reason,
      }),
    placeholderData: keepPreviousData,
  })
}

export function useMovementsPageQuery(search: MovementsSearch) {
  return useQuery(getMovementsPageQueryOptions(search))
}

// this product's stock rows, for the product-detail Inventory tab
export function getProductInventoryQueryOptions(productId: number) {
  return queryOptions({
    queryKey: ["inventory", "product", productId],
    queryFn: () => merchantApi.inventory.list({ limit: 100, productId }),
  })
}

export function useProductInventoryQuery(productId: number) {
  return useQuery(getProductInventoryQueryOptions(productId))
}

export function useCreateInventoryMovementMutation() {
  return useMutation({
    mutationFn: merchantApi.inventory.movements.create,
    onSuccess: () => {
      // list, movement history and the product-scoped view all share the
      // "inventory" key prefix
      queryClient.invalidateQueries({ queryKey: ["inventory"] })
      // a variant's derived stock (shown on the product page) lives off the
      // same inventory rows a movement just changed
      queryClient.invalidateQueries({ queryKey: ["products"] })
    },
  })
}
