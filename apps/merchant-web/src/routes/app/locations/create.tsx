import { createFileRoute } from '@tanstack/react-router'
import { CreateLocationView } from '../../../features/locations/views/create-location.view'
import { getListLocationsQueryOptions } from '../../../features/locations/locations.hooks'
import { requirePermission } from '../../../lib/require-permission'
import { queryClient } from '../../../lib/react-query-client'

export const Route = createFileRoute('/app/locations/create')({
  staticData: { breadcrumb: 'Create' },
  beforeLoad: async ({ context }) => {
    requirePermission(context, 'locations:write')
    // the view frames the account's first location differently (OS-689);
    // prefetch so that copy doesn't flash in. Never throws — a failed fetch
    // just falls back to the generic form.
    await queryClient.prefetchQuery(getListLocationsQueryOptions())
  },
  component: CreateLocationView,
})
