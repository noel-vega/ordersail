import { createFileRoute } from "@tanstack/react-router";
import { ListFailedOrdersView } from "../../../features/failed-orders/views/list-failed-orders.view";
import { getFailedOrdersQueryOptions } from "../../../features/failed-orders/failed-orders.hooks";
import { queryClient } from "../../../lib/react-query-client";
import { requirePermission } from '../../../lib/require-permission'

export const Route = createFileRoute("/app/failed-orders/")({
  staticData: { breadcrumb: "Failed Orders" },
  beforeLoad: async ({ context }) => {
    requirePermission(context, 'orders:read')
    await queryClient.ensureQueryData(getFailedOrdersQueryOptions());
  },
  component: ListFailedOrdersView,
});
