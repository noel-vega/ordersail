import { useMutation } from "@tanstack/react-query";
import type { ChangePasswordDto } from "merchant-sdk";
import { merchantApi } from "../../lib/merchant-api-client";
import { queryClient } from "../../lib/react-query-client";

// Its own file rather than an addition to me.hooks.ts: the password is a
// credential, not part of the Profile aspect those hooks serve (ADR 0001).
export function useChangePasswordMutation() {
  return useMutation({
    // the card reports every failure inline, against the field at fault —
    // a wrong current password is a field-level problem, and a toast alone
    // doesn't say which of the three inputs was wrong
    meta: { skipGlobalErrorToast: true },
    // arrow, not a bare method reference — changePassword() is an AdminClient
    // method and needs `this`
    mutationFn: (params: ChangePasswordDto) =>
      merchantApi.changePassword(params),
    onSuccess: () => {
      // The API revoked every other refresh-token family and rotated this
      // browser's, handing back an access token minted from freshly read
      // claims; the SDK has already adopted it. Drop the cached identity so
      // nothing keeps serving values derived from the old one out of its 60s
      // staleTime — the same invalidation every other auth mutation does.
      void queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });
}
