import { useMutation, useQueryClient } from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"
import { getAuthMeQueryOptions } from "./permissions.hooks"

// Query keys generally aren't scoped by user id, so any cached data (not
// just ["auth", "me"], which has a 60s staleTime) can leak across an
// identity change in the same tab — a new sign-in, accepting an invite, or
// clearing the session on logout. A route relying on ensureQueryData (like
// /app's forced-MFA-enrollment redirect) could otherwise act on the
// previous user's stale permissions/mfaEnrollmentSatisfied. Clearing the
// whole cache is the safe default; nothing here is expensive to refetch.
function useResetQueryCache() {
    const queryClient = useQueryClient()
    return () => queryClient.clear()
}

export function useSignInMutation(){
    const resetQueryCache = useResetQueryCache()
    return useMutation({
        // the form renders its own inline error
        meta: { skipGlobalErrorToast: true },
        mutationFn: (credentials: Parameters<typeof merchantApi.signIn>[0]) =>
            merchantApi.signIn(credentials),
        onSuccess: resetQueryCache,
    })
}

export function useSignUpMutation(){
    const resetQueryCache = useResetQueryCache()
    return useMutation({
        // the form renders its own inline error
        meta: { skipGlobalErrorToast: true },
        mutationFn: (signup: Parameters<typeof merchantApi.signUp>[0]) =>
            merchantApi.signUp(signup),
        onSuccess: resetQueryCache,
    })
}

export function useAcceptInviteMutation(){
    const resetQueryCache = useResetQueryCache()
    return useMutation({
        // the form renders its own inline error
        meta: { skipGlobalErrorToast: true },
        mutationFn: (params: Parameters<typeof merchantApi.acceptInvite>[0]) =>
            merchantApi.acceptInvite(params),
        onSuccess: resetQueryCache,
    })
}

export function useVerifyMfaChallengeMutation(){
    const resetQueryCache = useResetQueryCache()
    return useMutation({
        // the form renders its own inline error
        meta: { skipGlobalErrorToast: true },
        mutationFn: (params: Parameters<typeof merchantApi.verifyMfaChallenge>[0]) =>
            merchantApi.verifyMfaChallenge(params),
        onSuccess: resetQueryCache,
    })
}

export function useVerifyEmailMutation(){
    const resetQueryCache = useResetQueryCache()
    return useMutation({
        meta: { skipGlobalErrorToast: true },
        mutationFn: (params: Parameters<typeof merchantApi.verifyEmail>[0]) =>
            merchantApi.verifyEmail(params),
        onSuccess: resetQueryCache,
    })
}

export function useResendVerificationMutation(){
    return useMutation({
        meta: { skipGlobalErrorToast: true },
        mutationFn: () => merchantApi.resendVerification(),
    })
}

// for a tab that stayed open while the link was used elsewhere — its access
// token still carries emailVerified: false, and a refresh recomputes it.
// Refresh and me() both resolve undefined (not throw) when the session is
// gone, so that's reported as "signed-out" rather than mistaken for
// "unverified"; real request failures reject into onError.
export function useRecheckEmailVerifiedMutation(){
    const queryClient = useQueryClient()
    return useMutation({
        meta: { skipGlobalErrorToast: true },
        mutationFn: async (): Promise<"verified" | "unverified" | "signed-out"> => {
            const token = await merchantApi.refreshAccessToken()
            if (!token) return "signed-out"
            queryClient.clear()
            const me = await queryClient.fetchQuery(getAuthMeQueryOptions())
            if (!me) return "signed-out"
            return me.emailVerified ? "verified" : "unverified"
        },
    })
}

export function useLogoutMutation(){
    const resetQueryCache = useResetQueryCache()
    return useMutation({
        mutationFn: () => merchantApi.logout(),
        onSuccess: resetQueryCache,
    })
}