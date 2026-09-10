import { createFileRoute } from '@tanstack/react-router'
import { ProductListView } from '../../../features/products/views/list-products.view'
import { getListProductsQueryOptions } from '../../../features/products/products.hooks'
import { queryClient } from '../../../lib/react-query-client'

export const Route = createFileRoute('/app/products/')({
  staticData: { breadcrumb: 'Products' },
  beforeLoad: async () => {
    await queryClient.ensureQueryData(getListProductsQueryOptions())
  },
  component: ProductListView,
})
