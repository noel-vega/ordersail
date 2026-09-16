import { createFileRoute } from "@tanstack/react-router";
import { SecurityView } from "../../../features/mfa/views/security.view";

// deliberately no requirePermission() call — this is a personal page for
// the signed-in user's own account, not gated by account:read/write like
// the rest of /app/settings. Every authenticated user (Owner or staff)
// manages their own MFA the same way.
export const Route = createFileRoute("/app/settings/security")({
  staticData: { breadcrumb: "Security" },
  component: SecurityView,
});
