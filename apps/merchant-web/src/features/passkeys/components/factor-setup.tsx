import { useState } from "react";
import { ApiError, type MfaEnrollResponse } from "merchant-sdk";
import { KeyRoundIcon, SmartphoneIcon } from "lucide-react";
import { Button } from "ui/button";
import { merchantApi } from "../../../lib/merchant-api-client";
import { useEnrollMfaMutation } from "../../mfa/mfa.hooks";
import { EnrollMfaDialog } from "../../mfa/components/enroll-mfa-dialog";
import { AddPasskeyDialog } from "./add-passkey-dialog";
import { browserSupportsWebAuthn } from "../webauthn";

// The one "set up a sign-in factor" flow, shared by every place that asks
// for one: the factor-required prompt at gated actions (a dialog) and the
// second step of joining via an invite (inline on the page).
//
// It's a hook plus two components rather than one component because the
// chooser and the flows it launches have different lifetimes: the prompt
// dialog closes itself before a nested flow opens, which would unmount the
// flow along with it if they were one tree. So the caller renders
// <FactorSetupOptions> wherever the choice belongs and <FactorSetupDialogs>
// somewhere that stays mounted.
export function useFactorSetup(opts: {
  // a nested flow is about to open — the prompt dialog uses it to get out
  // of the way first
  onStarted?: () => void;
  // fired once a factor exists AND any recovery codes were acknowledged.
  // Both enrollment paths re-mint the caller's access token with the factor
  // claims set, so whatever was blocked can proceed straight away.
  onEnrolled: () => void;
  // the caller already holds the user's password in memory (they typed it on
  // this screen moments ago) — spares them the authenticator flow's
  // "current password" re-prompt. Leave unset anywhere the user has merely
  // been signed in for a while: there the prompt is the point.
  knownPassword?: string;
}) {
  const enroll = useEnrollMfaMutation();
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [passkeyOptions, setPasskeyOptions] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [enrollment, setEnrollment] = useState<MfaEnrollResponse | null>(null);

  async function startPasskey() {
    setError(null);
    setStarting(true);
    try {
      const options = await merchantApi.passkeys.registerOptions();
      opts.onStarted?.();
      setPasskeyOptions(options as Record<string, unknown>);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Couldn't start — try again.",
      );
    } finally {
      setStarting(false);
    }
  }

  async function startAuthenticator() {
    setError(null);
    setStarting(true);
    try {
      const result = await enroll.mutateAsync();
      if (result) {
        opts.onStarted?.();
        setEnrollment(result);
      }
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Couldn't start — try again.",
      );
    } finally {
      setStarting(false);
    }
  }

  return {
    error,
    clearError: () => setError(null),
    starting,
    startPasskey,
    startAuthenticator,
    passkeyOptions,
    closePasskey: () => setPasskeyOptions(null),
    enrollment,
    closeEnrollment: () => setEnrollment(null),
    onEnrolled: opts.onEnrolled,
    knownPassword: opts.knownPassword,
  };
}

type FactorSetup = ReturnType<typeof useFactorSetup>;

// Both options are offered together and inline — passkey first because it's
// the better one, authenticator plainly visible below rather than behind a
// disclosure. Deliberately NOT chosen by capability detection: the browser
// can say whether a *built-in* authenticator exists, but not whether the
// user could scan a QR with their phone or plug in a security key, so a
// detection-driven branch would hide the authenticator option from some of
// the people who need it and show it to people who don't.
export function FactorSetupOptions(props: { setup: FactorSetup }) {
  const { setup } = props;
  const supportsPasskeys = browserSupportsWebAuthn();

  return (
    <>
      {setup.error && <p className="text-sm text-destructive">{setup.error}</p>}

      <div className="space-y-2 py-2">
        {supportsPasskeys && (
          <Button
            className="w-full justify-start"
            onClick={setup.startPasskey}
            disabled={setup.starting}
          >
            <KeyRoundIcon />
            Add a passkey
          </Button>
        )}
        <Button
          variant="outline"
          className="w-full justify-start"
          onClick={setup.startAuthenticator}
          disabled={setup.starting}
        >
          <SmartphoneIcon />
          Use an authenticator app
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        A passkey uses Face ID, Touch ID or your password manager — nothing to
        install. An authenticator app works anywhere, including on a shared
        computer.
      </p>
    </>
  );
}

export function FactorSetupDialogs(props: { setup: FactorSetup }) {
  const { setup } = props;

  return (
    <>
      <AddPasskeyDialog
        optionsJSON={setup.passkeyOptions}
        onOpenChange={(open) => !open && setup.closePasskey()}
        onRegistered={setup.onEnrolled}
      />
      <EnrollMfaDialog
        otpauthUrl={setup.enrollment?.otpauthUrl ?? null}
        onOpenChange={(open) => !open && setup.closeEnrollment()}
        onConfirmed={setup.onEnrolled}
        knownPassword={setup.knownPassword}
      />
    </>
  );
}
