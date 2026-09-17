import { createFileRoute, redirect } from "@tanstack/react-router";
import z from "zod";
import { queryClient } from "../lib/react-query-client";
import { getAuthMeQueryOptions } from "../features/auth/permissions.hooks";
import { VerifyEmailView } from "../features/auth/views/verify-email.view";

// requires a session (root beforeLoad sends signed-out visitors to /signin
// and back): the emailed token proves inbox control, never identity. Without
// ?token this is the post-signup lobby; with it, it verifies the caller.
export const Route = createFileRoute("/verify-email")({
  validateSearch: z.object({ token: z.string().optional() }),
  beforeLoad: async ({ search }) => {
    const me = await queryClient.ensureQueryData(getAuthMeQueryOptions());
    // nothing to wait for — but a link still gets processed, so a verified
    // user opening someone else's link sees why it didn't apply
    if (me?.emailVerified && !search.token) {
      throw redirect({ to: "/app" });
    }
  },
  component: RouteComponent,
});

function RouteComponent() {
  const { token } = Route.useSearch();
  return <VerifyEmailView token={token} />;
}
