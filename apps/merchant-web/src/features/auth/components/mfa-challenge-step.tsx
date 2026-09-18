import { useState } from "react";
import { ApiError, type MfaChallenge } from "merchant-sdk";
import { Field, FieldLabel } from "ui/field";
import { Input } from "ui/input";
import { Alert, AlertDescription, AlertTitle } from "ui/alert";
import { Button } from "ui/button";
import { InfoIcon, KeyRoundIcon } from "lucide-react";
import { useVerifyMfaChallengeMutation } from "../auth.hooks";
import { merchantApi } from "../../../lib/merchant-api-client";
import { queryClient } from "../../../lib/react-query-client";
import {
  browserSupportsWebAuthn,
  PasskeyCeremonyError,
  runAuthentication,
} from "../../passkeys/webauthn";

// shown in place of the sign-in form (same view, no route change) once
// signin() returns a challenge instead of a token — the account has a
// confirmed MFA factor, so a password alone isn't enough
export function MfaChallengeStep(props: {
  challengeToken: string;
  methods: MfaChallenge["methods"];
  onVerified: () => void;
  onBack: () => void;
}) {
  const verify = useVerifyMfaChallengeMutation();
  const [code, setCode] = useState("");
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [error, setError] = useState("");
  const [passkeyPending, setPasskeyPending] = useState(false);

  // `methods` reflects what this user actually holds, so we never render a
  // passkey button for someone who has none. The browser check is separate:
  // they may hold a passkey but be on a browser that can't present one, in
  // which case the code path has to remain reachable.
  const offersPasskey =
    props.methods.includes("passkey") && browserSupportsWebAuthn();

  // Whether the code form is shown up front. With a passkey available it
  // starts collapsed behind "Use a code instead", so the better option is
  // the obvious one — but it's one click away, never hidden.
  const [showCodeForm, setShowCodeForm] = useState(!offersPasskey);

  async function handlePasskey() {
    setError("");
    setPasskeyPending(true);
    try {
      const options = await merchantApi.passkeys.challengeOptions({
        challengeToken: props.challengeToken,
      });
      const response = await runAuthentication(options);
      await merchantApi.passkeys.challengeVerify({
        challengeToken: props.challengeToken,
        response: response as unknown as Record<string, unknown>,
      });
      // same reset every other auth mutation does — query keys aren't
      // user-scoped, so a previous user's cache must not survive sign-in
      queryClient.clear();
      props.onVerified();
    } catch (err) {
      if (err instanceof PasskeyCeremonyError) {
        // a dismissed prompt isn't a failure worth shouting about
        if (!err.silent) setError(err.message);
        return;
      }
      setError(
        err instanceof ApiError ? err.message : "Couldn't verify — try again.",
      );
    } finally {
      setPasskeyPending(false);
    }
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    verify.mutate(
      { challengeToken: props.challengeToken, code },
      {
        onError: (err) => {
          setError(
            err instanceof ApiError
              ? err.message
              : "Couldn't verify — try again.",
          );
        },
        onSuccess: () => {
          props.onVerified();
        },
      },
    );
  }

  return (
    <div className="h-full flex items-center">
      <div className="max-w-sm mx-auto w-full space-y-8">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">
            {offersPasskey && !showCodeForm
              ? "Confirm it's you"
              : "Enter your code"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {offersPasskey && !showCodeForm
              ? "Use your passkey to finish signing in."
              : useRecoveryCode
                ? "Enter one of your saved recovery codes."
                : "Enter the 6-digit code from your authenticator app."}
          </p>
        </div>

        {error && (
          <Alert variant="destructive">
            <InfoIcon />
            <AlertTitle>Verification failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {offersPasskey && (
          <Button
            type="button"
            className="w-full"
            onClick={handlePasskey}
            disabled={passkeyPending}
          >
            <KeyRoundIcon />
            {passkeyPending ? "Waiting for your device..." : "Use a passkey"}
          </Button>
        )}

        {showCodeForm ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <Field>
              <FieldLabel>
                {useRecoveryCode ? "Recovery code" : "6-digit code"}
              </FieldLabel>
              <Input
                autoFocus
                inputMode={useRecoveryCode ? "text" : "numeric"}
                placeholder={useRecoveryCode ? "XXXXX-XXXXX" : "123456"}
                value={code}
                onChange={(e) => setCode(e.currentTarget.value)}
              />
            </Field>

            <Button
              type="submit"
              variant={offersPasskey ? "outline" : "default"}
              className="w-full"
              disabled={verify.isPending || !code}
            >
              {verify.isPending ? "Verifying..." : "Verify"}
            </Button>
          </form>
        ) : (
          // The escape hatch for a device that can't present the passkey —
          // a different machine, a browser without WebAuthn, a lost device.
          // Visible, not hidden behind a disclosure.
          <button
            type="button"
            className="w-full text-sm text-muted-foreground underline-offset-4 hover:underline"
            onClick={() => setShowCodeForm(true)}
          >
            Can&apos;t use a passkey on this device?
          </button>
        )}

        <div className="flex items-center justify-between text-sm">
          {showCodeForm ? (
            <button
              type="button"
              className="text-muted-foreground underline-offset-4 hover:underline"
              onClick={() => {
                setUseRecoveryCode((v) => !v);
                setCode("");
                setError("");
              }}
            >
              {useRecoveryCode
                ? "Use an authenticator code instead"
                : "Use a recovery code instead"}
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            className="text-muted-foreground underline-offset-4 hover:underline"
            onClick={props.onBack}
          >
            Back
          </button>
        </div>
      </div>
    </div>
  );
}
