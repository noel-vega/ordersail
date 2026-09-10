import { createFileRoute, redirect } from "@tanstack/react-router";

// "/" is fully handled by __root's beforeLoad (authed → home, otherwise
// → /signin), so this route only exists to own the path. The redirect here
// is a belt-and-suspenders fallback and never actually runs.
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/signin" });
  },
});
