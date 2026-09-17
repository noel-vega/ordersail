import { createFileRoute } from "@tanstack/react-router";
import z from "zod";
import { VerifyEmailView } from "../features/auth/views/verify-email.view";

// public — the emailed link may be opened with no session at all
export const Route = createFileRoute("/verify-email")({
  validateSearch: z.object({ token: z.string() }),
  component: RouteComponent,
});

function RouteComponent() {
  const { token } = Route.useSearch();
  return <VerifyEmailView token={token} />;
}
