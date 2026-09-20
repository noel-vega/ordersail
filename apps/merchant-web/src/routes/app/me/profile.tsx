import { createFileRoute } from "@tanstack/react-router";
import { ProfileView } from "../../../features/me/views/profile.view";
import { getMyProfileQueryOptions } from "../../../features/me/me.hooks";
import { queryClient } from "../../../lib/react-query-client";
import { FormSkeleton } from "../../../components/skeletons";

// Deliberately no requirePermission(): this is the signed-in user's own
// profile, reachable by every authenticated user including one holding zero
// permissions. The endpoints behind it take no id, so they can only address
// the caller.
export const Route = createFileRoute("/app/me/profile")({
  staticData: { breadcrumb: "Profile" },
  beforeLoad: async () => {
    await queryClient.ensureQueryData(getMyProfileQueryOptions());
  },
  pendingComponent: () => <FormSkeleton fields={4} />,
  component: ProfileView,
});
