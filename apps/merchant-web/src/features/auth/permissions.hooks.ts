import { queryOptions, useQuery } from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"

// the current user's identity + effective permission keys. Effective perms
// change only when an owner edits a role, so a modest staleTime is fine —
// refetch-on-mount + the 60s access-token refresh keep it current enough.
export function getAuthMeQueryOptions() {
  return queryOptions({
    queryKey: ["auth", "me"],
    queryFn: () => merchantApi.me(),
    staleTime: 60_000,
  })
}

export function useAuthMe() {
  return useQuery(getAuthMeQueryOptions())
}
