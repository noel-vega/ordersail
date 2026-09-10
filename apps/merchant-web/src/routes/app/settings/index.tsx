import { createFileRoute } from "@tanstack/react-router";
import { SettingsView } from "../../../features/account/views/settings.view";
import { getAccountQueryOptions } from "../../../features/account/account.hooks";
import { queryClient } from "../../../lib/react-query-client";
import { FormSkeleton } from "../../../components/skeletons";

export const Route = createFileRoute("/app/settings/")({
  staticData: { breadcrumb: "Settings" },
  beforeLoad: async () => {
    await queryClient.ensureQueryData(getAccountQueryOptions());
  },
  pendingComponent: FormSkeleton,
  component: SettingsView,
});
