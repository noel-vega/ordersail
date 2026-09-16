import { createFileRoute } from '@tanstack/react-router'
import { DashboardView } from '../../../features/dashboard/views/dashboard.view'
import { getDashboardSummaryQueryOptions } from '../../../features/dashboard/dashboard.hooks'
import { getFailedOrdersQueryOptions } from '../../../features/failed-orders/failed-orders.hooks'
import { queryClient } from '../../../lib/react-query-client'
import { requirePermission } from '../../../lib/require-permission'

export const Route = createFileRoute('/app/dashboard/')({
  staticData: { breadcrumb: 'Dashboard' },
  beforeLoad: async ({ context }) => {
    requirePermission(context, 'dashboard:read')
    await Promise.all([
      queryClient.ensureQueryData(getDashboardSummaryQueryOptions()),
      queryClient.ensureQueryData(getFailedOrdersQueryOptions()),
    ])
  },
  component: DashboardView,
})
