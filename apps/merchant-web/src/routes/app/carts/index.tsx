import { createFileRoute } from '@tanstack/react-router'
import { ListCartsView } from '../../../features/carts/views/list-carts.view'
import { getListCartsQueryOptions } from '../../../features/carts/carts.hooks'
import { queryClient } from '../../../lib/react-query-client'
import { requirePermission } from '../../../lib/require-permission'

export const Route = createFileRoute('/app/carts/')({
  staticData: { breadcrumb: 'Carts' },
  beforeLoad: async ({ context }) => {
    requirePermission(context, 'orders:read')
    await queryClient.ensureQueryData(getListCartsQueryOptions())
  },
  component: ListCartsView,
})
