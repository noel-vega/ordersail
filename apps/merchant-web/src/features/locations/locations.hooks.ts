import { queryOptions, useMutation, useQuery } from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"
import { queryClient } from "../../lib/react-query-client"

export function getListLocationsQueryOptions() {
  return queryOptions({
    queryKey: ["locations"],
    queryFn: () => merchantApi.locations.list({ limit: 100 }),
  })
}

export function useListLocationsQuery() {
  return useQuery(getListLocationsQueryOptions())
}

export function useCreateLocationMutation() {
  return useMutation({
    mutationFn: merchantApi.locations.create,
    onSuccess: () => {
      queryClient.invalidateQueries(getListLocationsQueryOptions())
    },
  })
}

export function useUpdateLocationMutation() {
  return useMutation({
    mutationFn: ({
      id,
      ...params
    }: { id: number } & Parameters<typeof merchantApi.locations.update>[1]) =>
      merchantApi.locations.update(id, params),
    onSuccess: () => {
      queryClient.invalidateQueries(getListLocationsQueryOptions())
    },
  })
}
