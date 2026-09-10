import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { merchantApi } from "../../lib/merchant-api-client";
import { queryClient } from "../../lib/react-query-client";

export function getListPosDevicesQueryOptions() {
  return queryOptions({
    queryKey: ["pos-devices"],
    queryFn: merchantApi.posDevices.list,
  });
}

export function useListPosDevicesQuery() {
  return useQuery(getListPosDevicesQueryOptions());
}

function invalidatePosDevices() {
  queryClient.invalidateQueries(getListPosDevicesQueryOptions());
}

export function useCreatePosDeviceMutation() {
  return useMutation({
    mutationFn: merchantApi.posDevices.create,
    onSuccess: invalidatePosDevices,
  });
}

export function useUpdatePosDeviceMutation() {
  return useMutation({
    mutationFn: ({
      id,
      ...params
    }: { id: number } & Parameters<typeof merchantApi.posDevices.update>[1]) =>
      merchantApi.posDevices.update(id, params),
    onSuccess: invalidatePosDevices,
  });
}

export function useRevokePosDeviceMutation() {
  return useMutation({
    mutationFn: merchantApi.posDevices.revoke,
    onSuccess: invalidatePosDevices,
  });
}

export function useRotatePairingMutation() {
  return useMutation({
    mutationFn: merchantApi.posDevices.rotatePairing,
    onSuccess: invalidatePosDevices,
  });
}
