import { useMutation } from "@tanstack/react-query";
import { merchantApi } from "../../lib/merchant-api-client";
import { queryClient } from "../../lib/react-query-client";

function invalidateAuthMe() {
  return queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
}

export function useEnrollMfaMutation() {
  return useMutation({
    // the enroll dialog shows its own inline error
    meta: { skipGlobalErrorToast: true },
    mutationFn: () => merchantApi.mfa.enroll(),
  });
}

export function useConfirmMfaMutation() {
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: (params: Parameters<typeof merchantApi.mfa.confirm>[0]) =>
      merchantApi.mfa.confirm(params),
    onSuccess: invalidateAuthMe,
  });
}

export function useDisableMfaMutation() {
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: (params: Parameters<typeof merchantApi.mfa.disable>[0]) =>
      merchantApi.mfa.disable(params),
    onSuccess: invalidateAuthMe,
  });
}

export function useRegenerateRecoveryCodesMutation() {
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: (
      params: Parameters<typeof merchantApi.mfa.regenerateRecoveryCodes>[0],
    ) => merchantApi.mfa.regenerateRecoveryCodes(params),
  });
}
