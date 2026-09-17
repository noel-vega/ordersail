import { createFileRoute } from "@tanstack/react-router";
import z from "zod";
import { SignInView } from "../features/auth/views/signin.view";

export const Route = createFileRoute("/signin")({
  validateSearch: z.object({
    redirect: z.string().optional(),
    // set by the reset-password screen after a successful reset
    reset: z.boolean().optional(),
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const { redirect, reset } = Route.useSearch();
  return <SignInView redirect={redirect} passwordReset={reset} />;
}
