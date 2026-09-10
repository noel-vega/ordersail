import { createFileRoute } from '@tanstack/react-router'
import { CreateProductView } from '../../../features/products/views/create-product.view'
import { requirePermission } from '../../../lib/require-permission'

export const Route = createFileRoute('/app/products/create')({
  staticData: { breadcrumb: 'Create' },
  beforeLoad: ({ context }) => {
    requirePermission(context, 'products:write')
  },
  component: CreateProductView,
})