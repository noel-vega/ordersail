import { createFileRoute } from '@tanstack/react-router'
import { CreateLocationView } from '../../../features/locations/views/create-location.view'
import { requirePermission } from '../../../lib/require-permission'

export const Route = createFileRoute('/app/locations/create')({
  staticData: { breadcrumb: 'Create' },
  beforeLoad: ({ context }) => {
    requirePermission(context, 'locations:write')
  },
  component: CreateLocationView,
})
