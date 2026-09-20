import { createFileRoute } from "@tanstack/react-router";
import { ProfileView } from "../../../features/me/views/profile.view";
import { getMyProfileQueryOptions } from "../../../features/me/me.hooks";
import { getAuthMeQueryOptions } from "../../../features/auth/permissions.hooks";
import { queryClient } from "../../../lib/react-query-client";
import { FormSkeleton } from "../../../components/skeletons";

// Deliberately no requirePermission(): this is the signed-in user's own
// profile, reachable by every authenticated user including one holding zero
// permissions. The endpoints behind it take no id, so they can only address
// the caller.
export const Route = createFileRoute("/app/me/profile")({
  staticData: { breadcrumb: "Profile" },
  // Both queries the view reads, not just the profile: the email field is
  // fed by GET /auth/me, and priming only one of them let a cold or errored
  // cache render an empty disabled box under "This is the address you sign
  // in with". Awaiting it here means the field either has a value or the
  // route fails honestly into the error boundary.
  beforeLoad: async () => {
    await Promise.all([
      queryClient.ensureQueryData(getMyProfileQueryOptions()),
      queryClient.ensureQueryData(getAuthMeQueryOptions()),
    ]);
  },
  pendingComponent: () => <FormSkeleton fields={4} />,
  component: ProfileView,
});
