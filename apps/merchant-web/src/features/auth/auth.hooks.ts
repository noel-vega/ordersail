import { useMutation } from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"

export function useSignInMutation(){
    return useMutation({
        mutationFn: (credentials: Parameters<typeof merchantApi.signIn>[0]) =>
            merchantApi.signIn(credentials)
    })
}

export function useSignUpMutation(){
    return useMutation({
        mutationFn: (signup: Parameters<typeof merchantApi.signUp>[0]) =>
            merchantApi.signUp(signup)
    })
}

export function useAcceptInviteMutation(){
    return useMutation({
        mutationFn: (params: Parameters<typeof merchantApi.acceptInvite>[0]) =>
            merchantApi.acceptInvite(params)
    })
}

export function useLogoutMutation(){
    return useMutation({
        mutationFn: () => merchantApi.logout()
    })
}