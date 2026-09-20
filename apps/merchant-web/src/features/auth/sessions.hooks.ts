import { useMutation } from "@tanstack/react-query";
import { merchantApi } from "../../lib/merchant-api-client";

// "Sign out everywhere else". Nothing is invalidated on success: this
// browser's session is deliberately the one the API keeps alive, and none of
// the cached values here — /auth/me included — describe sessions, so none of
// them has changed. This browser's tokens aren't touched either — its family
// is spared and left unrotated; the sessions that did change belong to other
// browsers, which find out at their next refresh. Errors go to the global
// toast, like the other confirm-only AlertDialog actions (revoking an API
// key, a POS device) — including the 409 the API answers when it can't tell
// which session is this one, whose message says to sign in again.
export function useRevokeOtherSessionsMutation() {
  return useMutation({
    mutationFn: () => merchantApi.revokeOtherSessions(),
  });
}
