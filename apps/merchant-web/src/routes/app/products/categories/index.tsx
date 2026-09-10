import { createFileRoute } from '@tanstack/react-router'
import { ListCategoriesView } from '../../../../features/categories/views/list-categories'
import { getListCategoriesQueryOptions } from '../../../../features/categories/categories.hooks'
import { listSearchSchema } from '../../../../lib/list-search'
import { queryClient } from '../../../../lib/react-query-client'

export const Route = createFileRoute('/app/products/categories/')({
  staticData: { breadcrumb: 'Categories' },
  validateSearch: listSearchSchema,
  beforeLoad: async ({ search }) => {
    await queryClient.ensureQueryData(getListCategoriesQueryOptions(search))
  },
  component: ListCategoriesView,
})
