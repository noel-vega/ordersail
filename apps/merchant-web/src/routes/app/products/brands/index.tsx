import { createFileRoute } from '@tanstack/react-router'
import { ListBrandsView } from '../../../../features/brands/views/list-brands.view'
import { getListBrandsQueryOptions } from '../../../../features/brands/brands.hooks'
import { listSearchSchema } from '../../../../lib/list-search'
import { queryClient } from '../../../../lib/react-query-client'

export const Route = createFileRoute('/app/products/brands/')({
  staticData: { breadcrumb: 'Brands' },
  validateSearch: listSearchSchema,
  beforeLoad: async ({ search }) => {
    await queryClient.ensureQueryData(getListBrandsQueryOptions(search))
  },
  component: ListBrandsView,
})
