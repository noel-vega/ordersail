import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { merchantApi } from "../../lib/merchant-api-client";
import { queryClient } from "../../lib/react-query-client";

// no pagination — failed orders are rare and always fetched in full; the
// dashboard "Failed Orders" card reads unresolvedCount off this same query
export function getFailedOrdersQueryOptions() {
  return queryOptions({
    queryKey: ["failed-orders"],
    queryFn: () => merchantApi.failedOrders.list(),
  });
}

export function useFailedOrdersQuery() {
  return useQuery(getFailedOrdersQueryOptions());
}

export function useRetryFailedOrderMutation() {
  return useMutation({
    mutationFn: (id: number) => merchantApi.failedOrders.retry(id),
    onSuccess: () => {
      // the retry either resolves the row now (order already existed) or
      // re-enqueues it; a re-enqueued job resolves the row when the worker
      // finishes, so refetch either way
      queryClient.invalidateQueries({ queryKey: ["failed-orders"] });
    },
  });
}
