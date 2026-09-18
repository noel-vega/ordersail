import { useEffect, useMemo, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { loadConnectAndInitialize } from "@stripe/connect-js";
import {
  ConnectAccountManagement,
  ConnectAccountOnboarding,
  ConnectBalances,
  ConnectComponentsProvider,
  ConnectNotificationBanner,
} from "@stripe/react-connect-js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "ui/card";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import { usePermissions } from "../../auth/permission-context";
import { useAuthMe } from "../../auth/permissions.hooks";
import { FactorRequiredDialog } from "../../passkeys/components/factor-required-dialog";
import {
  useCreateAccountSessionMutation,
  useCreateOnboardingSessionMutation,
  useRefreshStripeConnectStatus,
  useStripeConnectStatusQuery,
} from "../stripe-connect.hooks";

function StatusBadge({
  connected,
  chargesEnabled,
}: {
  connected: boolean;
  chargesEnabled: boolean;
}) {
  if (chargesEnabled) return <Badge>Payments enabled</Badge>;
  if (connected) return <Badge variant="secondary">Onboarding incomplete</Badge>;
  return <Badge variant="outline">Not connected</Badge>;
}

const route = getRouteApi("/app/payments/");

export function PaymentsView() {
  const status = useStripeConnectStatusQuery();
  const createAccountSession = useCreateAccountSessionMutation();
  const createOnboardingSession = useCreateOnboardingSessionMutation();
  const me = useAuthMe();
  const [factorPrompt, setFactorPrompt] = useState(false);
  const refreshStatus = useRefreshStripeConnectStatus();
  const canConnect = usePermissions().has("payments:write");
  const { onboarding } = route.useSearch();
  const navigate = route.useNavigate();
  // deep-linked from the dashboard checklist — jump straight into the
  // embedded onboarding flow, but only if it isn't already done and the user
  // may actually connect
  const [showOnboarding, setShowOnboarding] = useState(
    () => (onboarding ?? false) && !status.data?.chargesEnabled && canConnect,
  );

  // drop the ?onboarding param once consumed so a refresh doesn't re-trigger
  useEffect(() => {
    if (onboarding) navigate({ search: {}, replace: true });
  }, [onboarding, navigate]);

  // needed both while onboarding and afterward (to show account info), so
  // it's created as soon as there's a connected account to talk to, not
  // just while the onboarding flow is open
  const shouldInitConnect = showOnboarding || (status.data?.connected ?? false);

  // Which session to ask for. "Still needs onboarding" covers both a
  // first-time merchant (no Stripe account at all) and one who started and
  // didn't finish — the latter has a row, so keying this off `connected`
  // would hand them a management session with no onboarding component and
  // leave them unable to resume.
  const needsOnboarding = !(status.data?.detailsSubmitted ?? false);

  // Checked before Connect.js initializes, not after. The gated session call
  // happens inside fetchClientSecret, where a 403 surfaces as an opaque
  // Stripe error rather than anything the merchant can act on — so this is
  // the one call site where the proactive check isn't just nicer, it's the
  // difference between an explanation and a dead embed.
  function startOnboarding() {
    if (!(me.data?.hasMfaFactor ?? true)) {
      setFactorPrompt(true);
      return;
    }
    setShowOnboarding(true);
  }

  // a single Connect instance is reused for every embedded component below —
  // fetchClientSecret is called again automatically by Connect.js if the
  // session expires, and both session calls are idempotent
  const connectInstance = useMemo(() => {
    if (!shouldInitConnect) return null;
    return loadConnectAndInitialize({
      publishableKey: import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY,
      fetchClientSecret: async () => {
        const session = needsOnboarding
          ? await createOnboardingSession.mutateAsync()
          : await createAccountSession.mutateAsync();
        if (!session) throw new Error("Failed to create Stripe account session");
        return session.clientSecret;
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldInitConnect, needsOnboarding]);

  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Stripe payments</CardTitle>
            {!status.isLoading && (
              <StatusBadge
                connected={status.data?.connected ?? false}
                chargesEnabled={status.data?.chargesEnabled ?? false}
              />
            )}
          </div>
          <CardDescription>
            Connect a Stripe account so your storefront can accept payments.
            Customers pay you directly — funds never pass through this
            platform.
          </CardDescription>
        </CardHeader>
        {!showOnboarding && !status.data?.chargesEnabled && (
          <CardContent>
            {canConnect ? (
              <Button onClick={startOnboarding}>
                {status.data?.connected
                  ? "Continue onboarding"
                  : "Connect with Stripe"}
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                An account owner needs to connect Stripe.
              </p>
            )}
          </CardContent>
        )}
      </Card>

      {connectInstance && (
        <ConnectComponentsProvider connectInstance={connectInstance}>
          {showOnboarding && (
            <Card>
              <CardContent>
                <ConnectAccountOnboarding
                  onExit={() => {
                    setShowOnboarding(false);
                    refreshStatus();
                  }}
                />
              </CardContent>
            </Card>
          )}

          {status.data?.chargesEnabled && (
            <>
              <ConnectNotificationBanner />

              <Card>
                <CardHeader>
                  <CardTitle>Balance</CardTitle>
                </CardHeader>
                <CardContent>
                  <ConnectBalances />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Account details</CardTitle>
                  <CardDescription>
                    Business profile, bank account, and verification status.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ConnectAccountManagement />
                </CardContent>
              </Card>
            </>
          )}
        </ConnectComponentsProvider>
      )}
      <FactorRequiredDialog
        open={factorPrompt}
        onOpenChange={setFactorPrompt}
        action="connect Stripe"
        onReady={() => setShowOnboarding(true)}
      />
    </div>
  );
}
