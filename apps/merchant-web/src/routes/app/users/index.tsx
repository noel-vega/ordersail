import { createFileRoute } from '@tanstack/react-router'
import { ListUsersView } from '../../../features/users/views/list-users.view'
import { getListUsersQueryOptions } from '../../../features/users/users.hooks'
import { listSearchSchema } from '../../../lib/list-search'
import { queryClient } from '../../../lib/react-query-client'

export const Route = createFileRoute('/app/users/')({
  staticData: { breadcrumb: 'Users' },
  validateSearch: listSearchSchema,
  beforeLoad: async ({ search }) => {
    await queryClient.ensureQueryData(getListUsersQueryOptions(search))
  },
  component: ListUsersView,
})
