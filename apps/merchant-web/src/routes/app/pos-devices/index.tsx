import { createFileRoute } from "@tanstack/react-router";
import { ListPosDevicesView } from "../../../features/pos-devices/views/list-pos-devices.view";
import { getListPosDevicesQueryOptions } from "../../../features/pos-devices/pos-devices.hooks";
import { queryClient } from "../../../lib/react-query-client";
import { requirePermission } from "../../../lib/require-permission";

export const Route = createFileRoute("/app/pos-devices/")({
  staticData: { breadcrumb: "POS Devices" },
  beforeLoad: async ({ context }) => {
    requirePermission(context, "pos_devices:read");
    await queryClient.ensureQueryData(getListPosDevicesQueryOptions());
    // the mint / edit forms load locations lazily — they need locations:read,
    // which a pos_devices-only role may not hold
  },
  component: ListPosDevicesView,
});
