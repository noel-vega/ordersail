import { queryOptions, useMutation, useQuery } from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"
import { queryClient } from "../../lib/react-query-client"

export function getListBrandsQueryOptions() {
  return queryOptions({
    queryKey: ["brands"],
    queryFn: merchantApi.brands.list,
  })
}

export function useListBrandsQuery() {
  return useQuery(getListBrandsQueryOptions())
}

export function useCreateBrandMutation() {
  return useMutation({
    mutationFn: merchantApi.brands.create,
    onSuccess: () => {
      queryClient.invalidateQueries(getListBrandsQueryOptions())
    },
  })
}
