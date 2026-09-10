import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"
import { queryClient } from "../../lib/react-query-client"
import { PAGE_SIZE, pageOffset, type ListSearch } from "../../lib/list-search"

export function getListUsersQueryOptions(
  search: ListSearch = { page: 1, q: "" },
) {
  return queryOptions({
    queryKey: ["users", search],
    queryFn: () =>
      merchantApi.users.list({
        limit: PAGE_SIZE,
        offset: pageOffset(search.page),
        q: search.q || undefined,
      }),
    placeholderData: keepPreviousData,
  })
}

export function useListUsersQuery(search: ListSearch) {
  return useQuery(getListUsersQueryOptions(search))
}

export function getUserQueryOptions(id: number) {
  return queryOptions({
    queryKey: ["users", "detail", id],
    queryFn: () => merchantApi.users.get(id),
  })
}

export function useUserSuspenseQuery(id: number) {
  return useSuspenseQuery(getUserQueryOptions(id))
}

export function useCreateUserMutation() {
  return useMutation({
    mutationFn: merchantApi.users.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] })
    },
  })
}

export function useUpdateUserRolesMutation() {
  return useMutation({
    mutationFn: ({ id, roleIds }: { id: number; roleIds: number[] }) =>
      merchantApi.users.updateRoles(id, roleIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] })
    },
  })
}

export function useUpdateUserMutation() {
  return useMutation({
    mutationFn: ({
      id,
      ...params
    }: { id: number } & Parameters<typeof merchantApi.users.update>[1]) =>
      merchantApi.users.update(id, params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] })
      // a self-edit changes the name shown in the sidebar account menu
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] })
    },
  })
}

export function useResendInviteMutation() {
  return useMutation({
    mutationFn: (id: number) => merchantApi.users.resendInvite(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] })
    },
  })
}

export function useRevokeInviteMutation() {
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: (id: number) => merchantApi.users.revokeInvite(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] })
    },
  })
}

export function useDeactivateUserMutation() {
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: (id: number) => merchantApi.users.deactivate(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] })
    },
  })
}

export function useReactivateUserMutation() {
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: (id: number) => merchantApi.users.reactivate(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] })
    },
  })
}
