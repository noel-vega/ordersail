import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { merchantApi } from "../../lib/merchant-api-client";
import { queryClient } from "../../lib/react-query-client";

// Its own key rather than a field on ["auth","me"]: /auth/me has a 60s
// staleTime and is cleared wholesale on every auth mutation, which is the
// wrong lifecycle for a list the user edits in place.
export function getPasskeysQueryOptions() {
  return queryOptions({
    queryKey: ["auth", "passkeys"],
    queryFn: () => merchantApi.passkeys.list(),
  });
}

export function usePasskeys() {
  return useQuery(getPasskeysQueryOptions());
}

// Registering, renaming or removing all change /auth/me too — passkeyCount
// and hasMfaFactor live there, and the security page reads both.
function invalidatePasskeys() {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["auth", "passkeys"] }),
    queryClient.invalidateQueries({ queryKey: ["auth", "me"] }),
  ]);
}

export function useRegisterPasskeyMutation() {
  return useMutation({
    // the dialog renders its own inline error
    meta: { skipGlobalErrorToast: true },
    mutationFn: (
      params: Parameters<typeof merchantApi.passkeys.registerVerify>[0],
    ) => merchantApi.passkeys.registerVerify(params),
    onSuccess: invalidatePasskeys,
  });
}

export function useRenamePasskeyMutation() {
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: (vars: { id: number; nickname: string }) =>
      merchantApi.passkeys.rename(vars.id, { nickname: vars.nickname }),
    onSuccess: invalidatePasskeys,
  });
}

export function useRemovePasskeyMutation() {
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: (vars: { id: number; password: string }) =>
      merchantApi.passkeys.remove(vars.id, { password: vars.password }),
    onSuccess: invalidatePasskeys,
  });
}
