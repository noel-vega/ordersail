import { useState } from "react";
import { ApiError } from "merchant-sdk";
import { Field, FieldLabel } from "ui/field";
import { Input } from "ui/input";
import { Alert, AlertDescription, AlertTitle } from "ui/alert";
import { Button } from "ui/button";
import { InfoIcon } from "lucide-react";
import { useVerifyMfaChallengeMutation } from "../auth.hooks";

// shown in place of the sign-in form (same view, no route change) once
// signin() returns a challenge instead of a token — the account has a
// confirmed MFA factor, so a password alone isn't enough
export function MfaChallengeStep(props: {
  challengeToken: string;
  onVerified: () => void;
  onBack: () => void;
}) {
  const verify = useVerifyMfaChallengeMutation();
  const [code, setCode] = useState("");
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [error, setError] = useState("");

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    verify.mutate(
      { challengeToken: props.challengeToken, code },
      {
        onError: (err) => {
          setError(
            err instanceof ApiError ? err.message : "Couldn't verify — try again.",
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
          <h1 className="text-xl font-semibold">Enter your code</h1>
          <p className="text-sm text-muted-foreground">
            {useRecoveryCode
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
            className="w-full"
            disabled={verify.isPending || !code}
          >
            {verify.isPending ? "Verifying..." : "Verify"}
          </Button>
        </form>

        <div className="flex items-center justify-between text-sm">
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
