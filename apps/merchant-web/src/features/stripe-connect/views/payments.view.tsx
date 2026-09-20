import { useEffect, useMemo, useRef, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { ApiError } from "merchant-sdk";
import { loadConnectAndInitialize } from "@stripe/connect-js";
import {
  ConnectAccountManagement,
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
  useCreateOnboardingLinkMutation,
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
  const createOnboardingLink = useCreateOnboardingLinkMutation();
  const me = useAuthMe();
  const refreshStatus = useRefreshStripeConnectStatus();
  const canConnect = usePermissions().has("payments:write");
  const { onboarding } = route.useSearch();
  const navigate = route.useNavigate();

  const [factorPrompt, setFactorPrompt] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  // stays true after the link arrives — the page is on its way to Stripe, and
  // re-enabling the button for that half second invites a second click, which
  // would mint a second link and race the first navigation
  const [redirecting, setRedirecting] = useState(false);

  const chargesEnabled = status.data?.chargesEnabled ?? false;
  const connected = status.data?.connected ?? false;
  // Finished Stripe's form at least once. Separate from chargesEnabled
  // because Stripe can switch charges back off on a finished merchant (a new
  // requirement comes due, a verification fails) — and that's exactly when
  // they need the embedded banner and account management to see why.
  const detailsSubmitted = status.data?.detailsSubmitted ?? false;
  const showEmbedded = chargesEnabled || detailsSubmitted;

  // Onboarding is Stripe-hosted (OS-498): ask the API for a link, then leave.
  // Links are single-use and expire within minutes, so one is only ever
  // minted from an explicit action — never on page load, never prefetched.
  //
  // Connecting is gated on holding a factor (OS-492). Asking here means the
  // prompt arrives with its reason attached; the server is the enforcement.
  // `?? true` so a not-yet-loaded /auth/me doesn't flash the prompt.
  function startOnboarding() {
    if (!(me.data?.hasMfaFactor ?? true)) {
      setFactorPrompt(true);
      return;
    }
    void goToStripe();
  }

  // Separate from the check above because the factor prompt resumes HERE, not
  // there: right after enrolling, the cached /auth/me can still say "no
  // factor", and re-checking it would reopen the prompt the merchant just
  // completed. They hold one — and if somehow they don't, the server says so.
  async function goToStripe() {
    setLinkError(null);
    setRedirecting(true);
    try {
      const link = await createOnboardingLink.mutateAsync();
      if (!link) throw new Error("no link");
      window.location.assign(link.url);
    } catch (err) {
      setRedirecting(false);
      // the factor-gate refusal already arrives as the global backstop toast,
      // with a "Set one up" action this line couldn't offer — don't say it
      // twice
      if (err instanceof ApiError && err.code === "MFA_FACTOR_REQUIRED") return;
      // otherwise keep the server's reason
      setLinkError(
        err instanceof ApiError
          ? err.message
          : "Couldn't reach Stripe — try again.",
      );
    }
  }

  // Coming back from Stripe. `return` does NOT mean finished — it also fires
  // on "Save for later" — so it only triggers a live status lookup, and the
  // page renders whatever is true. `refresh` means the link was stale or
  // already spent; Stripe expects us to mint another and send them back.
  //
  // The ref makes this once-per-arrival: clearing the param is async, and a
  // re-run in between (StrictMode, a re-render) would mint a second link.
  // It also means a failed re-mint lands on an error and a button, not a
  // redirect loop.
  const handledArrival = useRef(false);
  useEffect(() => {
    if (!onboarding || handledArrival.current) return;
    handledArrival.current = true;
    navigate({ search: {}, replace: true });
    if (onboarding === "return") {
      // webhook delivery can lag the redirect; if this lookup fails the
      // cached status still renders and account.updated catches it up
      refreshStatus().catch(() => {});
    } else if (canConnect && connected && !chargesEnabled) {
      // Stripe only sends anyone to refresh_url from a link we minted, so an
      // account already exists and isn't finished. Holding to that keeps a
      // bare /app/payments?onboarding=refresh URL (pasted, bookmarked, sent
      // by someone else) from creating a Stripe account or bouncing a fully
      // onboarded merchant off to Stripe without a click. Status is already
      // in the cache here — the route's beforeLoad awaits it.
      void startOnboarding();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarding]);

  // Back from Stripe via the browser's back button restores this page from
  // the bfcache with `redirecting` still true — a permanently dead button.
  useEffect(() => {
    function onPageShow(event: PageTransitionEvent) {
      if (event.persisted) setRedirecting(false);
    }
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  // Connect.js now only serves a merchant who has been through onboarding —
  // banner, balances, account management — so it initializes on exactly the
  // condition those render under. fetchClientSecret is called again
  // automatically if the session expires; the session call is idempotent and
  // ungated.
  const connectInstance = useMemo(() => {
    if (!showEmbedded) return null;
    return loadConnectAndInitialize({
      publishableKey: import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY,
      fetchClientSecret: async () => {
        const session = await createAccountSession.mutateAsync();
        if (!session) throw new Error("Failed to create Stripe account session");
        return session.clientSecret;
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showEmbedded]);

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
        {!chargesEnabled && (
          <CardContent className="space-y-2">
            {canConnect ? (
              <>
                <Button onClick={startOnboarding} disabled={redirecting}>
                  {redirecting
                    ? "Taking you to Stripe..."
                    : connected
                      ? "Continue onboarding"
                      : "Connect with Stripe"}
                </Button>
                <p className="text-sm text-muted-foreground">
                  You&apos;ll finish setup on Stripe&apos;s site and come
                  straight back here.
                </p>
                {linkError && (
                  <p className="text-sm text-destructive">{linkError}</p>
                )}
              </>
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
        </ConnectComponentsProvider>
      )}
      <FactorRequiredDialog
        open={factorPrompt}
        onOpenChange={setFactorPrompt}
        action="connect Stripe"
        onReady={goToStripe}
      />
    </div>
  );
}
