import { queryOptions, useMutation, useQuery } from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"
import { queryClient } from "../../lib/react-query-client"

export function getListApiKeysQueryOptions() {
  return queryOptions({
    queryKey: ["api-keys"],
    queryFn: merchantApi.apiKeys.list,
  })
}

export function useListApiKeysQuery() {
  return useQuery(getListApiKeysQueryOptions())
}

export function useCreateApiKeyMutation() {
  return useMutation({
    // the create dialog shows the error inline next to the label field
    meta: { skipGlobalErrorToast: true },
    mutationFn: (vars?: { label?: string }) =>
      merchantApi.apiKeys.create(vars?.label ? { label: vars.label } : undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-keys"] })
    },
  })
}

export function useRevokeApiKeyMutation() {
  return useMutation({
    mutationFn: (id: number) => merchantApi.apiKeys.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-keys"] })
    },
  })
}
