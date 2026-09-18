import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { PaymentsView } from '../../../features/stripe-connect/views/payments.view'
import { getStripeConnectStatusQueryOptions } from '../../../features/stripe-connect/stripe-connect.hooks'
import { queryClient } from '../../../lib/react-query-client'
import { requirePermission } from '../../../lib/require-permission'

// ?onboarding=return|refresh — where Stripe-hosted onboarding sends the
// merchant back to (OS-498). The values are set by merchant-api's
// createOnboardingLink; anything else is dropped rather than acted on.
const paymentsSearchSchema = z.object({
  onboarding: z.enum(['return', 'refresh']).optional().catch(undefined),
})

export const Route = createFileRoute('/app/payments/')({
  staticData: { breadcrumb: 'Payments' },
  validateSearch: paymentsSearchSchema,
  beforeLoad: async ({ context }) => {
    requirePermission(context, 'payments:read')
    await queryClient.ensureQueryData(getStripeConnectStatusQueryOptions())
  },
  component: PaymentsView,
})
