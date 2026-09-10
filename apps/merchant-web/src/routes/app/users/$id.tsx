import z from "zod";
import { createFileRoute } from "@tanstack/react-router";
import { getUserQueryOptions } from "../../../features/users/users.hooks";
import { queryClient } from "../../../lib/react-query-client";
import { requirePermission } from "../../../lib/require-permission";
import { UserDetailView } from "../../../features/users/views/user-detail.view";
import { DetailSkeleton } from "../../../components/skeletons";

export const Route = createFileRoute("/app/users/$id")({
  params: {
    parse: z.object({ id: z.coerce.number() }).parse,
  },
  staticData: {
    breadcrumb: (params) => {
      const user = queryClient.getQueryData(
        getUserQueryOptions(params.id as number).queryKey,
      );
      return user ? `${user.firstName} ${user.lastName}` : `User #${params.id}`;
    },
  },
  beforeLoad: async ({ context, params }) => {
    // a user can always open their own profile; viewing anyone else needs
    // users:read
    if (context.userId !== params.id) {
      requirePermission(context, "users:read");
    }
    await queryClient.ensureQueryData(getUserQueryOptions(params.id));
  },
  pendingComponent: DetailSkeleton,
  component: RouteComponent,
});

function RouteComponent() {
  const { id } = Route.useParams();
  return <UserDetailView id={id} />;
}
