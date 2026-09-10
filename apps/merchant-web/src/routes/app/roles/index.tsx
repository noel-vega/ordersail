import { createFileRoute } from '@tanstack/react-router'
import { ListRolesView } from '../../../features/roles/views/list-roles.view'
import { getListRolesQueryOptions } from '../../../features/roles/roles.hooks'
import { queryClient } from '../../../lib/react-query-client'

export const Route = createFileRoute('/app/roles/')({
  staticData: { breadcrumb: 'Roles' },
  beforeLoad: async () => {
    await queryClient.ensureQueryData(getListRolesQueryOptions())
  },
  component: ListRolesView,
})
