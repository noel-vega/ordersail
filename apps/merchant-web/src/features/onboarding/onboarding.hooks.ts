import { queryOptions, useQuery } from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"

export function getOnboardingStatusQueryOptions() {
  return queryOptions({
    queryKey: ["onboarding", "status"],
    queryFn: merchantApi.onboarding.getStatus,
  })
}

export function useOnboardingStatusQuery() {
  return useQuery({
    ...getOnboardingStatusQueryOptions(),
    // the dashboard route remounts on navigation, so re-fetching on mount is
    // enough for "complete a step, come back, it's checked" without wiring
    // every mutating action
    refetchOnMount: "always",
  })
}
