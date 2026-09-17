import { createFileRoute } from "@tanstack/react-router";
import z from "zod";
import { ResetPasswordView } from "../features/auth/views/reset-password.view";

export const Route = createFileRoute("/reset-password")({
  validateSearch: z.object({ token: z.string() }),
  component: RouteComponent,
});

function RouteComponent() {
  const { token } = Route.useSearch();
  return <ResetPasswordView token={token} />;
}
