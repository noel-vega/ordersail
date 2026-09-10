import { createFileRoute } from '@tanstack/react-router'
import { CreateUserView } from '../../../features/users/views/create-user.view'
import { requirePermission } from '../../../lib/require-permission'

export const Route = createFileRoute('/app/users/create')({
  staticData: { breadcrumb: 'Add user' },
  beforeLoad: ({ context }) => {
    requirePermission(context, 'users:write')
  },
  component: CreateUserView,
})
