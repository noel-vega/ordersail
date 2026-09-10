import { queryOptions, useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"
import { queryClient } from "../../lib/react-query-client"
import { getListUsersQueryOptions } from "../users/users.hooks"

// no pagination — an account's role list is small and bounded, always
// fetched in full
export function getListRolesQueryOptions() {
  return queryOptions({
    queryKey: ["roles"],
    queryFn: () => merchantApi.roles.list(),
  })
}

export function useListRolesQuery() {
  return useQuery(getListRolesQueryOptions())
}

export function getRoleQueryOptions(id: number) {
  return queryOptions({
    queryKey: ["roles", id],
    queryFn: async () => {
      const role = await merchantApi.roles.getById(id)
      if(!role) {
        throw new Error("Role not found")
      }
      return role
    }
  })
}

export function useRoleSuspenseQuery(id: number) {
  return useSuspenseQuery(getRoleQueryOptions(id))
}

// the permission catalog is fixed and code-defined — never changes at runtime
export function getPermissionsCatalogQueryOptions() {
  return queryOptions({
    queryKey: ["permissions"],
    queryFn: merchantApi.permissions.list,
    staleTime: Infinity,
  })
}

export function usePermissionsCatalogSuspenseQuery() {
  return useSuspenseQuery(getPermissionsCatalogQueryOptions())
}

export function useCreateRoleMutation() {
  return useMutation({
    mutationFn: merchantApi.roles.create,
    onSuccess: () => {
      queryClient.invalidateQueries(getListRolesQueryOptions())
    },
  })
}

export function useUpdateRoleMutation() {
  return useMutation({
    mutationFn: ({
      id,
      ...params
    }: { id: number } & Parameters<typeof merchantApi.roles.update>[1]) =>
      merchantApi.roles.update(id, params),
    onSuccess: () => {
      queryClient.invalidateQueries(getListRolesQueryOptions())
      // the Users list embeds each user's role name as a denormalized
      // snapshot — a rename needs to refresh it too, not just the roles list
      queryClient.invalidateQueries(getListUsersQueryOptions())
    },
  })
}

export function useDeleteRoleMutation() {
  return useMutation({
    mutationFn: (id: number) => merchantApi.roles.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries(getListRolesQueryOptions())
    },
  })
}
