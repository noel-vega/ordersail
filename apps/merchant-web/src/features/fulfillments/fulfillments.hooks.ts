import { useMutation } from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"
import { invalidateOrders } from "../orders/orders.hooks"

export function useGetFulfillmentRatesMutation() {
  return useMutation({
    mutationFn: merchantApi.fulfillments.getRates,
  })
}

export function useCreateFulfillmentMutation() {
  return useMutation({
    mutationFn: merchantApi.fulfillments.create,
    // the order detail, every orders list page and the dashboard's
    // recentOrders all surface fulfillmentStatus; without this they'd show a
    // stale "Unfulfilled" badge until an unrelated refetch
    onSuccess: () => invalidateOrders(),
  })
}
