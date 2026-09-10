import { createFileRoute } from '@tanstack/react-router'
import { requirePermission } from '../../../../lib/require-permission'

export const Route = createFileRoute('/app/products/categories/create')({
  staticData: { breadcrumb: 'Create' },
  beforeLoad: ({ context }) => {
    requirePermission(context, 'products:write')
  },
  component: RouteComponent,
})

function RouteComponent() {
  return <div>Hello "/app/products/categories/create"!</div>
}
