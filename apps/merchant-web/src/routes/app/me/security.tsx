import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SecurityView } from "../../../features/mfa/views/security.view";

// deliberately no requirePermission() call — this is a personal page for
// the signed-in user themselves, which is why it lives under /app/me rather
// than /app/settings, where account:read/write gates the merchant tenant.
// Every authenticated user (Owner or staff) manages their own MFA the same
// way.
//
// `required` is set by /app's beforeLoad redirect (OS-475) when the
// account-wide MFA policy (OS-473) applies and this user hasn't enrolled
// yet — lets the view show why they landed here instead of the app.
export const Route = createFileRoute("/app/me/security")({
  validateSearch: z.object({ required: z.boolean().optional() }),
  staticData: { breadcrumb: "Security" },
  component: RouteComponent,
});

function RouteComponent() {
  const { required } = Route.useSearch();
  return <SecurityView required={required} />;
}
