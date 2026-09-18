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

// called when the merchant lands back from Stripe-hosted onboarding —
// webhook delivery can lag the redirect, so this does a live Stripe lookup
// instead of trusting the cached DB status
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

// Two calls, because they are two different actions (OS-492, OS-498).
//
// The onboarding link creates the Stripe account when there isn't one and
// returns a Stripe-hosted URL; it's the money action, gated on holding a
// passkey or authenticator. The link is single-use and expires in minutes, so
// this is a mutation fired from a click, never a query. The error is rendered
// next to the button that caused it, so the global toast would only repeat
// it — but the MFA_FACTOR_REQUIRED backstop sits above that opt-out and still
// fires.
export function useCreateOnboardingLinkMutation() {
  return useMutation({
    mutationFn: () => merchantApi.stripeConnect.createOnboardingLink(),
    meta: { skipGlobalErrorToast: true },
  })
}

// The session behind the embedded management and balance components, for a
// merchant who has already finished — it refuses when no account exists and
// never enables onboarding, so it can't be used to slip past that gate.
export function useCreateAccountSessionMutation() {
  return useMutation({
    mutationFn: () => merchantApi.stripeConnect.createAccountSession(),
  })
}
