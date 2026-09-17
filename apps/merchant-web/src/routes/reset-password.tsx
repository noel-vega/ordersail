import { createFileRoute } from "@tanstack/react-router";
import z from "zod";
import { ResetPasswordView } from "../features/auth/views/reset-password.view";

export const Route = createFileRoute("/reset-password")({
  // optional so a truncated/missing token still reaches the view's
  // "invalid or expired → request a new link" state, not the route error page
  validateSearch: z.object({ token: z.string().optional() }),
  component: RouteComponent,
});

function RouteComponent() {
  const { token } = Route.useSearch();
  return <ResetPasswordView token={token} />;
}
