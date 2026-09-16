import { createFileRoute } from '@tanstack/react-router'
import { HomeView } from '../../features/home/views/home.view'
import { getOnboardingStatusQueryOptions } from '../../features/onboarding/onboarding.hooks'
import { queryClient } from '../../lib/react-query-client'

export const Route = createFileRoute('/app/')({
  staticData: { breadcrumb: 'Home' },
  beforeLoad: async () => {
    await queryClient.ensureQueryData(getOnboardingStatusQueryOptions())
  },
  component: HomeView,
})
