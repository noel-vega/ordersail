import { createFileRoute, redirect } from '@tanstack/react-router'
import { ListOrdersView } from '../../../features/orders/views/list-orders.view'
import {
  getListOrdersQueryOptions,
  orderListSearchSchema,
} from '../../../features/orders/orders.hooks'
import { lastPage } from '../../../lib/list-search'
import { queryClient } from '../../../lib/react-query-client'
import { requirePermission } from '../../../lib/require-permission'

export const Route = createFileRoute('/app/orders/')({
  staticData: { breadcrumb: 'Orders' },
  validateSearch: orderListSearchSchema,
  beforeLoad: async ({ search, context }) => {
    requirePermission(context, 'orders:read')
    const orders = await queryClient.ensureQueryData(
      getListOrdersQueryOptions(search),
    )
    // `?page=` past the end (a stale bookmark, a hand-edited URL) lands on the
    // last page instead of an empty table
    const last = lastPage(orders?.total ?? 0)
    if (search.page > last) {
      throw redirect({ to: '/app/orders', search: { page: last }, replace: true })
    }
  },
  component: ListOrdersView,
})
