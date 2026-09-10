import { queryOptions, useMutation, useQuery } from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"
import { queryClient } from "../../lib/react-query-client"

export function getListUsersQueryOptions() {
  return queryOptions({
    queryKey: ["users"],
    queryFn: () => merchantApi.users.list(),
  })
}

export function useListUsersQuery() {
  return useQuery(getListUsersQueryOptions())
}

export function useCreateUserMutation() {
  return useMutation({
    mutationFn: merchantApi.users.create,
    onSuccess: () => {
      queryClient.invalidateQueries(getListUsersQueryOptions())
    },
  })
}

export function useUpdateUserRolesMutation() {
  return useMutation({
    mutationFn: ({ id, roleIds }: { id: number; roleIds: number[] }) =>
      merchantApi.users.updateRoles(id, roleIds),
    onSuccess: () => {
      queryClient.invalidateQueries(getListUsersQueryOptions())
    },
  })
}
