import { OnboardingChecklist } from "../../onboarding/views/onboarding-checklist.view"

// The universal post-login landing page (appConfig.homeRoute) — every role
// lands here regardless of permissions, so this stays deliberately light:
// the onboarding checklist (hides itself once complete) and nothing that
// requires a specific permission. The revenue/orders/customers summary
// that used to live here moved to /app/dashboard, gated by dashboard:read.
export function HomeView() {
  return (
    <div className="space-y-6">
      <OnboardingChecklist />
    </div>
  )
}
