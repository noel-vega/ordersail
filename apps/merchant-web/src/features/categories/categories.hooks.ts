import { queryOptions, useMutation, useQuery } from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"
import { queryClient } from "../../lib/react-query-client"

export function getListCategoriesQueryOptions() {
  return queryOptions({
    queryKey: ["categories"],
    queryFn: () => merchantApi.categories.list({ limit: 100 }),
  })
}

export function useListCategoriesQuery() {
  return useQuery(getListCategoriesQueryOptions())
}

export function useCreateCategoryMutation() {
  return useMutation({
    mutationFn: merchantApi.categories.create,
    onSuccess: () => {
      queryClient.invalidateQueries(getListCategoriesQueryOptions())
    },
  })
}
