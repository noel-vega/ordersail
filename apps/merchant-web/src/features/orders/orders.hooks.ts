import { keepPreviousData, queryOptions, useMutation, useQuery } from "@tanstack/react-query"
import type { CancelOrderDto, RefundOrderDto } from "merchant-sdk"
import type { z } from "zod"
import { listSearchSchema, PAGE_SIZE, pageOffset } from "../../lib/list-search"
import { merchantApi } from "../../lib/merchant-api-client"
import { queryClient } from "../../lib/react-query-client"
import { getDashboardSummaryQueryOptions } from "../dashboard/dashboard.hooks"

// the orders API has no `q` yet, so the list only takes a page
export const orderListSearchSchema = listSearchSchema.pick({ page: true })

export type OrderListSearch = z.infer<typeof orderListSearchSchema>

export function getListOrdersQueryOptions(search: OrderListSearch = { page: 1 }) {
  return queryOptions({
    queryKey: ["orders", search],
    queryFn: () =>
      merchantApi.orders.list({
        limit: PAGE_SIZE,
        offset: pageOffset(search.page),
      }),
    placeholderData: keepPreviousData,
  })
}

export function useListOrdersQuery(search: OrderListSearch) {
  return useQuery(getListOrdersQueryOptions(search))
}

export function getOrderQueryOptions(id: number) {
  return queryOptions({
    queryKey: ["orders", id],
    queryFn: () => merchantApi.orders.getById(id),
  })
}

export function useOrderQuery(id: number) {
  return useQuery(getOrderQueryOptions(id))
}

// invalidates the order detail + the two views that also show its status
// (every orders list page and the dashboard's recentOrders, same findAll data).
// The ["orders"] prefix covers both the detail and each ["orders", { page }].
export function invalidateOrders() {
  queryClient.invalidateQueries({ queryKey: ["orders"] })
  queryClient.invalidateQueries(getDashboardSummaryQueryOptions())
}

export function useRefundOrderMutation(orderId: number) {
  return useMutation({
    // the refund sheet shows the error inline next to the form
    meta: { skipGlobalErrorToast: true },
    mutationFn: (body: RefundOrderDto) => merchantApi.orders.refund(orderId, body),
    onSuccess: () => invalidateOrders(),
  })
}

export function useCancelOrderMutation(orderId: number) {
  return useMutation({
    // the cancel dialog shows the error inline
    meta: { skipGlobalErrorToast: true },
    mutationFn: (body: CancelOrderDto) => merchantApi.orders.cancel(orderId, body),
    onSuccess: () => invalidateOrders(),
  })
}
