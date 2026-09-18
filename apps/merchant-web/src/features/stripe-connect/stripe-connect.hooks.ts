import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"

export function getStripeConnectStatusQueryOptions() {
  return queryOptions({
    queryKey: ["stripe-connect", "status"],
    queryFn: () => merchantApi.stripeConnect.getStatus(),
  })
}

export function useStripeConnectStatusQuery() {
  return useQuery(getStripeConnectStatusQueryOptions())
}

// called right after the embedded onboarding component exits — webhook
// delivery can lag, so this does a live Stripe lookup instead of trusting
// the cached DB status
export function useRefreshStripeConnectStatus() {
  const queryClient = useQueryClient()
  return async () => {
    const status = await queryClient.fetchQuery({
      queryKey: ["stripe-connect", "status"],
      queryFn: () => merchantApi.stripeConnect.getStatus({ refresh: true }),
    })
    // completing Stripe onboarding can tick the dashboard onboarding checklist
    queryClient.invalidateQueries({ queryKey: ["onboarding"] })
    return status
  }
}

// Two sessions, because they are two different actions (OS-492).
//
// Onboarding creates the Stripe account when there isn't one and enables the
// onboarding component; it's the money action, and it's gated on holding a
// passkey or authenticator. The management session is for a merchant who has
// already finished — it refuses when no account exists and never enables
// onboarding, so it can't be used to slip past that gate.
export function useCreateOnboardingSessionMutation() {
  return useMutation({
    mutationFn: () => merchantApi.stripeConnect.createOnboardingSession(),
  })
}

export function useCreateAccountSessionMutation() {
  return useMutation({
    mutationFn: () => merchantApi.stripeConnect.createAccountSession(),
  })
}
