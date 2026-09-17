import { createFileRoute } from "@tanstack/react-router";
import { ForgotPasswordView } from "../features/auth/views/forgot-password.view";

export const Route = createFileRoute("/forgot-password")({
  component: ForgotPasswordView,
});
