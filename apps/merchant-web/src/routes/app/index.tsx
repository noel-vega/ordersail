import { createFileRoute } from '@tanstack/react-router'
import { DashboardView } from '../../features/dashboard/views/dashboard.view'
import { getDashboardSummaryQueryOptions } from '../../features/dashboard/dashboard.hooks'
import { getOnboardingStatusQueryOptions } from '../../features/onboarding/onboarding.hooks'
import { queryClient } from '../../lib/react-query-client'

export const Route = createFileRoute('/app/')({
  staticData: { breadcrumb: 'Dashboard' },
  beforeLoad: async () => {
    await Promise.all([
      queryClient.ensureQueryData(getDashboardSummaryQueryOptions()),
      queryClient.ensureQueryData(getOnboardingStatusQueryOptions()),
    ])
  },
  component: DashboardView,
})
