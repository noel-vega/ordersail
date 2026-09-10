import z from 'zod'
import { createFileRoute } from '@tanstack/react-router'
import {
  getProductQueryOptions,
  getProductVariantsQueryOptions,
} from '../../../features/products/products.hooks'
import { queryClient } from '../../../lib/react-query-client'
import { ProductView } from '../../../features/products/views/product.view'
import { DetailSkeleton } from '../../../components/skeletons'

export const Route = createFileRoute('/app/products/$id')({
  params: {
    parse: z.object({id: z.coerce.number()}).parse
  },
  staticData: {
    breadcrumb: (params) => {
      const product = queryClient.getQueryData(
        getProductQueryOptions(params.id as number).queryKey,
      )
      return product?.name ?? `Product #${params.id}`
    },
  },
  beforeLoad: async ({params}) => {
    await Promise.all([
      queryClient.ensureQueryData(getProductQueryOptions(params.id)),
      queryClient.ensureQueryData(getProductVariantsQueryOptions(params.id)),
    ]);
  },
  pendingComponent: DetailSkeleton,
  component: RouteComponent,
})

function RouteComponent() {
  const {id} = Route.useParams()
  return <ProductView id={id} />
}