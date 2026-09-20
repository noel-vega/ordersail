import z from "zod";
import { createFileRoute } from "@tanstack/react-router";
import { getUserQueryOptions } from "../../../features/users/users.hooks";
import { queryClient } from "../../../lib/react-query-client";
import { requirePermission } from "../../../lib/require-permission";
import { StaffRecordView } from "../../../features/users/views/staff-record.view";
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
    // The staff record is administrative: viewing one always needs users:read,
    // including your own. Your own data lives at /app/me. Anything else would
    // admit a permissionless user the API then refuses — GET /users/:id has no
    // self-branch either.
    requirePermission(context, "users:read");
    await queryClient.ensureQueryData(getUserQueryOptions(params.id));
  },
  pendingComponent: DetailSkeleton,
  component: RouteComponent,
});

function RouteComponent() {
  const { id } = Route.useParams();
  return <StaffRecordView id={id} />;
}
