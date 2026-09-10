import z from "zod";
import { createFileRoute } from "@tanstack/react-router";
import {
  getRoleQueryOptions,
} from "../../../features/roles/roles.hooks";
import { queryClient } from "../../../lib/react-query-client";
import { RoleView } from "../../../features/roles/views/role.view";
import { DetailSkeleton } from "../../../components/skeletons";

export const Route = createFileRoute("/app/roles/$id")({
  params: {
    parse: z.object({ id: z.coerce.number() }).parse,
  },
  staticData: {
    breadcrumb: (params) => {
      const role = queryClient.getQueryData(
        getRoleQueryOptions(params.id as number).queryKey,
      );
      return role?.name ?? `Role #${params.id}`;
    },
  },
  beforeLoad: async ({ params }) => {
    await Promise.all([
      queryClient.ensureQueryData(getRoleQueryOptions(params.id)),
    ]);
  },
  pendingComponent: DetailSkeleton,
  component: RouteComponent,
});

function RouteComponent() {
  const { id } = Route.useParams();
  return <RoleView id={id} />;
}
