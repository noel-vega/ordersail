import { createFileRoute } from '@tanstack/react-router'
import { ListInventoryView } from '../../../features/inventory/views/list-inventory.view'
import {
  getInventoryPageQueryOptions,
  inventorySearchSchema,
} from '../../../features/inventory/inventory.hooks'
import { queryClient } from '../../../lib/react-query-client'
import { requirePermission } from '../../../lib/require-permission'

export const Route = createFileRoute('/app/inventory/')({
  staticData: { breadcrumb: 'Inventory' },
  validateSearch: inventorySearchSchema,
  beforeLoad: async ({ search, context }) => {
    requirePermission(context, 'inventory:read')
    await queryClient.ensureQueryData(getInventoryPageQueryOptions(search))
    // the location filter is loaded by the view, so a slow locations list
    // never holds up the page
  },
  component: ListInventoryView,
})
