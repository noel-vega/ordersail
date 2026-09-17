import { createFileRoute } from "@tanstack/react-router";
import { VerifyEmailGateView } from "../../features/auth/views/verify-email-gate.view";

// kept under /app so the sidebar stays — /app's beforeLoad redirects here
// while the caller's email is unverified
export const Route = createFileRoute("/app/verify-email")({
  staticData: { breadcrumb: "Verify email" },
  component: VerifyEmailGateView,
});
