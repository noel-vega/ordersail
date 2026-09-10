import { createFileRoute } from "@tanstack/react-router";
import { SettingsView } from "../../../features/account/views/settings.view";
import { getAccountQueryOptions } from "../../../features/account/account.hooks";
import { queryClient } from "../../../lib/react-query-client";
import { FormSkeleton } from "../../../components/skeletons";
import { requirePermission } from "../../../lib/require-permission";

export const Route = createFileRoute("/app/settings/")({
  staticData: { breadcrumb: "Settings" },
  beforeLoad: async ({ context }) => {
    requirePermission(context, "account:read");
    await queryClient.ensureQueryData(getAccountQueryOptions());
  },
  pendingComponent: FormSkeleton,
  component: SettingsView,
});
