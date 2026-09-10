import { createFileRoute } from '@tanstack/react-router'
import { ProductListView } from '../../../features/products/views/list-products.view'
import {
  getListProductsQueryOptions,
  productListSearchSchema,
} from '../../../features/products/products.hooks'
import { queryClient } from '../../../lib/react-query-client'

export const Route = createFileRoute('/app/products/')({
  staticData: { breadcrumb: 'Products' },
  validateSearch: productListSearchSchema,
  beforeLoad: async ({ search }) => {
    await queryClient.ensureQueryData(getListProductsQueryOptions(search))
  },
  component: ProductListView,
})
