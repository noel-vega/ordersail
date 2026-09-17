import { createFileRoute } from "@tanstack/react-router";
import z from "zod";
import { SignInView } from "../features/auth/views/signin.view";

export const Route = createFileRoute("/signin")({
  validateSearch: z.object({ redirect: z.string().optional() }),
  component: RouteComponent,
});

function RouteComponent() {
  const { redirect } = Route.useSearch();
  return <SignInView redirect={redirect} />;
}
