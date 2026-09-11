import z from "zod"
import { createFileRoute } from "@tanstack/react-router"
import { getCustomerQueryOptions } from "../../../features/customers/customers.hooks"
import { queryClient } from "../../../lib/react-query-client"
import { requirePermission } from "../../../lib/require-permission"
import { CustomerDetailView } from "../../../features/customers/views/customer-detail.view"
import { DetailSkeleton } from "../../../components/skeletons"

export const Route = createFileRoute("/app/customers/$id")({
  params: {
    parse: z.object({ id: z.coerce.number() }).parse,
  },
  staticData: {
    breadcrumb: (params) => {
      const customer = queryClient.getQueryData(
        getCustomerQueryOptions(params.id as number).queryKey,
      )
      return customer
        ? `${customer.firstName} ${customer.lastName}`
        : `Customer #${params.id}`
    },
  },
  beforeLoad: async ({ context, params }) => {
    requirePermission(context, "customers:read")
    await queryClient.ensureQueryData(getCustomerQueryOptions(params.id))
  },
  pendingComponent: DetailSkeleton,
  component: RouteComponent,
})

function RouteComponent() {
  const { id } = Route.useParams()
  return <CustomerDetailView id={id} />
}
