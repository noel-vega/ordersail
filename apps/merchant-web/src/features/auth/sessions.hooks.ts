import { useMutation } from "@tanstack/react-query";
import { merchantApi } from "../../lib/merchant-api-client";

// "Sign out everywhere else". Nothing is invalidated on success: this
// browser's session is deliberately the one the API spares and doesn't
// rotate, so no cached value here — /auth/me included — has changed. The
// sessions that did change belong to other browsers, which find out at their
// next refresh. Errors go to the global toast, like the other confirm-only
// AlertDialog actions (revoking an API key, a POS device).
export function useRevokeOtherSessionsMutation() {
  return useMutation({
    mutationFn: () => merchantApi.revokeOtherSessions(),
  });
}
