import { createFileRoute, redirect } from "@tanstack/react-router";

// /app/me is a container, not a page — Profile is its first tab.
export const Route = createFileRoute("/app/me/")({
  beforeLoad: () => {
    throw redirect({ to: "/app/me/profile" });
  },
});
