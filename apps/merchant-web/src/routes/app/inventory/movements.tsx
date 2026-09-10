import { createFileRoute } from '@tanstack/react-router'
import { ListInventoryMovementsView } from '../../../features/inventory/views/list-inventory-movements.view'
import {
  getMovementsPageQueryOptions,
  movementsSearchSchema,
} from '../../../features/inventory/inventory.hooks'
import { queryClient } from '../../../lib/react-query-client'
import { requirePermission } from '../../../lib/require-permission'

export const Route = createFileRoute('/app/inventory/movements')({
  staticData: { breadcrumb: 'Movements' },
  validateSearch: movementsSearchSchema,
  beforeLoad: async ({ search, context }) => {
    requirePermission(context, 'inventory:read')
    await queryClient.ensureQueryData(getMovementsPageQueryOptions(search))
  },
  component: ListInventoryMovementsView,
})
