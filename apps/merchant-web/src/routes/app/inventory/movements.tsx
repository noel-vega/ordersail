import { createFileRoute } from '@tanstack/react-router'
import { ListInventoryMovementsView } from '../../../features/inventory/views/list-inventory-movements.view'
import {
  getMovementsPageQueryOptions,
  movementsSearchSchema,
} from '../../../features/inventory/inventory.hooks'
import { queryClient } from '../../../lib/react-query-client'

export const Route = createFileRoute('/app/inventory/movements')({
  staticData: { breadcrumb: 'Movements' },
  validateSearch: movementsSearchSchema,
  beforeLoad: async ({ search }) => {
    await queryClient.ensureQueryData(getMovementsPageQueryOptions(search))
  },
  component: ListInventoryMovementsView,
})
