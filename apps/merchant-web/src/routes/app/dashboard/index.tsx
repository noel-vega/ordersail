import { createFileRoute } from '@tanstack/react-router'
import { DashboardView } from '../../../features/dashboard/views/dashboard.view'
import {
  getDashboardSalesQueryOptions,
  getDashboardSummaryQueryOptions,
} from '../../../features/dashboard/dashboard.hooks'
import { getFailedOrdersQueryOptions } from '../../../features/failed-orders/failed-orders.hooks'
import { queryClient } from '../../../lib/react-query-client'
import { requirePermission } from '../../../lib/require-permission'
import {
  dashboardSearchSchema,
  toApiRange,
} from '../../../features/dashboard/dashboard-range'

export const Route = createFileRoute('/app/dashboard/')({
  staticData: { breadcrumb: 'Dashboard' },
  // ?range=7d | ?from=…&to=… — see dashboard-range.ts (OS-193)
  validateSearch: dashboardSearchSchema,
  beforeLoad: async ({ context, search }) => {
    requirePermission(context, 'dashboard:read')
    await Promise.all([
      queryClient.ensureQueryData(getDashboardSummaryQueryOptions()),
      queryClient.ensureQueryData(
        getDashboardSalesQueryOptions(toApiRange(search).params),
      ),
      queryClient.ensureQueryData(getFailedOrdersQueryOptions()),
    ])
  },
  component: DashboardView,
})
