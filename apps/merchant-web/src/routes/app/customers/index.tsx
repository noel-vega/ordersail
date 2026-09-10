import { createFileRoute } from '@tanstack/react-router'
import { ListCustomersView } from '../../../features/customers/views/list-customers.view'
import { getListCustomersQueryOptions } from '../../../features/customers/customers.hooks'
import { listSearchSchema } from '../../../lib/list-search'
import { queryClient } from '../../../lib/react-query-client'
import { requirePermission } from '../../../lib/require-permission'

export const Route = createFileRoute('/app/customers/')({
  staticData: { breadcrumb: 'Customers' },
  validateSearch: listSearchSchema,
  beforeLoad: async ({ search, context }) => {
    requirePermission(context, 'customers:read')
    await queryClient.ensureQueryData(getListCustomersQueryOptions(search))
  },
  component: ListCustomersView,
})
