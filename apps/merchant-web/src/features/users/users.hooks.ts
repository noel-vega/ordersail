import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
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
