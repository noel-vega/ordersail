import { useMutation } from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"
import { queryClient } from "../../lib/react-query-client"
import { getOrderQueryOptions, getListOrdersQueryOptions } from "../orders/orders.hooks"
import { getDashboardSummaryQueryOptions } from "../dashboard/dashboard.hooks"

export function useGetFulfillmentRatesMutation() {
  return useMutation({
    mutationFn: merchantApi.fulfillments.getRates,
  })
}

export function useCreateFulfillmentMutation(orderId: number) {
  return useMutation({
    mutationFn: merchantApi.fulfillments.create,
    onSuccess: () => {
      // the order detail itself, plus the two other views that surface its
      // fulfillmentStatus (the orders list and the dashboard's recentOrders,
      // which reuses the same OrdersService.findAll data) — all three would
      // otherwise show a stale "Unfulfilled" badge until an unrelated refetch
      queryClient.invalidateQueries(getOrderQueryOptions(orderId))
      queryClient.invalidateQueries(getListOrdersQueryOptions())
      queryClient.invalidateQueries(getDashboardSummaryQueryOptions())
    },
  })
}
