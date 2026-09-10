import { queryOptions, useMutation, useQuery } from "@tanstack/react-query"
import type { CancelOrderDto, RefundOrderDto } from "merchant-sdk"
import { adminApi } from "../../lib/admin-api-client"
import { queryClient } from "../../lib/react-query-client"
import { getDashboardSummaryQueryOptions } from "../dashboard/dashboard.hooks"

export function getListOrdersQueryOptions() {
  return queryOptions({
    queryKey: ["orders"],
    queryFn: () => adminApi.orders.list(),
  })
}

export function useListOrdersQuery() {
  return useQuery(getListOrdersQueryOptions())
}

export function getOrderQueryOptions(id: number) {
  return queryOptions({
    queryKey: ["orders", id],
    queryFn: () => adminApi.orders.getById(id),
  })
}

export function useOrderQuery(id: number) {
  return useQuery(getOrderQueryOptions(id))
}

// invalidates the order detail + the two views that also show its status
// (the orders list and the dashboard's recentOrders, same findAll data)
function invalidateOrder(orderId: number) {
  queryClient.invalidateQueries(getOrderQueryOptions(orderId))
  queryClient.invalidateQueries(getListOrdersQueryOptions())
  queryClient.invalidateQueries(getDashboardSummaryQueryOptions())
}

export function useRefundOrderMutation(orderId: number) {
  return useMutation({
    mutationFn: (body: RefundOrderDto) => adminApi.orders.refund(orderId, body),
    onSuccess: () => invalidateOrder(orderId),
  })
}

export function useCancelOrderMutation(orderId: number) {
  return useMutation({
    mutationFn: (body: CancelOrderDto) => adminApi.orders.cancel(orderId, body),
    onSuccess: () => invalidateOrder(orderId),
  })
}
