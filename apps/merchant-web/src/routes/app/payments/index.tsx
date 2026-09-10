import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { PaymentsView } from '../../../features/stripe-connect/views/payments.view'
import { getStripeConnectStatusQueryOptions } from '../../../features/stripe-connect/stripe-connect.hooks'
import { queryClient } from '../../../lib/react-query-client'

// ?onboarding=true — set by the dashboard onboarding checklist's "Connect
// Stripe" CTA to auto-open the embedded Stripe onboarding flow on arrival
const paymentsSearchSchema = z.object({
  onboarding: z.boolean().optional().catch(undefined),
})

export const Route = createFileRoute('/app/payments/')({
  staticData: { breadcrumb: 'Payments' },
  validateSearch: paymentsSearchSchema,
  beforeLoad: async () => {
    await queryClient.ensureQueryData(getStripeConnectStatusQueryOptions())
  },
  component: PaymentsView,
})
