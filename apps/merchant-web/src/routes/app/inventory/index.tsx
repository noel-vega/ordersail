import { createFileRoute } from '@tanstack/react-router'
import { ListInventoryView } from '../../../features/inventory/views/list-inventory.view'
import {
  getInventoryPageQueryOptions,
  inventorySearchSchema,
} from '../../../features/inventory/inventory.hooks'
import { getListLocationsQueryOptions } from '../../../features/locations/locations.hooks'
import { queryClient } from '../../../lib/react-query-client'

export const Route = createFileRoute('/app/inventory/')({
  staticData: { breadcrumb: 'Inventory' },
  validateSearch: inventorySearchSchema,
  beforeLoad: async ({ search }) => {
    await Promise.all([
      queryClient.ensureQueryData(getInventoryPageQueryOptions(search)),
      queryClient.ensureQueryData(getListLocationsQueryOptions()),
    ])
  },
  component: ListInventoryView,
})
