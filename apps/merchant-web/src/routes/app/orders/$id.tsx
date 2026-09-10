import z from 'zod'
import { createFileRoute } from '@tanstack/react-router'
import { getOrderQueryOptions } from '../../../features/orders/orders.hooks'
import { queryClient } from '../../../lib/react-query-client'
import { requirePermission } from '../../../lib/require-permission'
import { OrderView } from '../../../features/orders/views/order.view'
import { DetailSkeleton } from '../../../components/skeletons'

export const Route = createFileRoute('/app/orders/$id')({
  params: {
    parse: z.object({ id: z.coerce.number() }).parse,
  },
  staticData: {
    breadcrumb: (params) => `Order #${params.id}`,
  },
  beforeLoad: async ({ params, context }) => {
    requirePermission(context, 'orders:read')
    await queryClient.ensureQueryData(getOrderQueryOptions(params.id))
  },
  pendingComponent: DetailSkeleton,
  component: RouteComponent,
})

function RouteComponent() {
  const { id } = Route.useParams()
  return <OrderView id={id} />
}
