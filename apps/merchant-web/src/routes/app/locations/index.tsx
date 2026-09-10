import { createFileRoute } from '@tanstack/react-router'
import { ListLocationsView } from '../../../features/locations/views/list-locations.view'
import { getListLocationsQueryOptions } from '../../../features/locations/locations.hooks'
import { listSearchSchema } from '../../../lib/list-search'
import { queryClient } from '../../../lib/react-query-client'

export const Route = createFileRoute('/app/locations/')({
  staticData: { breadcrumb: 'Locations' },
  validateSearch: listSearchSchema,
  beforeLoad: async ({ search }) => {
    await queryClient.ensureQueryData(getListLocationsQueryOptions(search))
  },
  component: ListLocationsView,
})
