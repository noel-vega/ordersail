import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { ApiError, type MfaChallenge } from "merchant-sdk";
import {
  SignInRequestBodySchema,
  type SignInRequestBody,
} from "../auth.api";
import { Field, FieldLabel } from "ui/field";
import { Input } from "ui/input";
import { Alert, AlertDescription, AlertTitle } from "ui/alert";
import { Button } from "ui/button";
import { useSignInMutation } from "../auth.hooks";
import { MfaChallengeStep } from "../components/mfa-challenge-step";
import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { InfoIcon, KeyRoundIcon } from "lucide-react";
import { safeRedirectPath } from "../safe-redirect";
import { merchantApi } from "../../../lib/merchant-api-client";
import { queryClient } from "../../../lib/react-query-client";
import {
  browserSupportsWebAuthn,
  PasskeyCeremonyError,
  runAuthentication,
} from "../../passkeys/webauthn";

export function SignInView(props: {
  redirect?: string;
  passwordReset?: boolean;
}) {
  const signInMutation = useSignInMutation();
  const navigate = useNavigate();
  const [errorMessage, setErrorMessage] = useState("");
  // the whole challenge, not just the token — `methods` says which factors
  // this user can actually present
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);
  const [passkeyPending, setPasskeyPending] = useState(false);

  // Hidden rather than disabled on a browser without WebAuthn — a dead
  // button on the sign-in page is worse than no button.
  const supportsPasskeys = browserSupportsWebAuthn();

  const form = useForm({
    resolver: zodResolver(SignInRequestBodySchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  function handleSubmit(formData: SignInRequestBody) {
    setErrorMessage("");
    signInMutation.mutate(formData, {
      onError: (err) => {
        // the API's 401 body is just "Unauthorized" — say what it means
        setErrorMessage(
          err instanceof ApiError && err.status !== 401
            ? err.message
            : "Invalid email or password.",
        );
      },
      onSuccess: (result) => {
        if (result && "mfaRequired" in result && result.mfaRequired) {
          setChallenge(result);
          return;
        }
        continueAfterSignIn();
      },
    });
  }

  // The second door: no email, no password. The credential is discoverable,
  // so the authenticator identifies the user by itself — which is why this
  // takes no input at all.
  async function handlePasskeySignIn() {
    setErrorMessage("");
    setPasskeyPending(true);
    try {
      const options = await merchantApi.passkeys.signInOptions();
      const response = await runAuthentication(options);
      await merchantApi.passkeys.signInVerify({
        response: response as unknown as Record<string, unknown>,
      });
      // same reset every other auth mutation does — query keys aren't
      // user-scoped, so a previous user's cache must not survive sign-in
      queryClient.clear();
      continueAfterSignIn();
    } catch (err) {
      if (err instanceof PasskeyCeremonyError) {
        // dismissing the prompt isn't a failure worth reporting
        if (!err.silent) setErrorMessage(err.message);
        return;
      }
      setErrorMessage(
        // the API answers a bad or unknown credential with a 401 whose body
        // says nothing useful
        err instanceof ApiError && err.status !== 401
          ? err.message
          : "That passkey didn't work. Try signing in with your password.",
      );
    } finally {
      setPasskeyPending(false);
    }
  }

  // back to wherever the root route bounced them from (only same-origin
  // paths), otherwise home
  function continueAfterSignIn() {
    navigate({ href: safeRedirectPath(props.redirect) });
  }

  function ErrorMessage() {
    if(!errorMessage) return null
    return (
      <Alert variant="destructive">
        <InfoIcon />
        <AlertTitle>Authentication Failed</AlertTitle>
        <AlertDescription>
          {errorMessage}
        </AlertDescription>
      </Alert>
    );
  }

  if (challenge) {
    return (
      <MfaChallengeStep
        challengeToken={challenge.challengeToken}
        methods={challenge.methods}
        onVerified={continueAfterSignIn}
        onBack={() => setChallenge(null)}
      />
    );
  }

  return (
    <div className="h-full flex items-center">
      <div className="max-w-sm mx-auto w-full space-y-8">
        {props.passwordReset && !errorMessage && (
          <Alert>
            <InfoIcon />
            <AlertTitle>Password updated</AlertTitle>
            <AlertDescription>
              Sign in with your new password.
            </AlertDescription>
          </Alert>
        )}
        <ErrorMessage />

        {supportsPasskeys && (
          <>
            <Button
              type="button"
              className="w-full"
              onClick={handlePasskeySignIn}
              disabled={passkeyPending}
            >
              <KeyRoundIcon />
              {passkeyPending
                ? "Waiting for your device..."
                : "Sign in with a passkey"}
            </Button>

            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">or</span>
              <span className="h-px flex-1 bg-border" />
            </div>
          </>
        )}

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <Controller
            control={form.control}
            name="email"
            render={({ field }) => (
              <Field>
                <FieldLabel>Email</FieldLabel>
                <Input type="email" placeholder="john.smith@example.com" {...field} />
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name="password"
            render={({ field }) => (
              <Field>
                <div className="flex items-center justify-between">
                  <FieldLabel>Password</FieldLabel>
                  <Link
                    to="/forgot-password"
                    className="text-sm text-muted-foreground underline-offset-4 hover:underline"
                  >
                    Forgot password?
                  </Link>
                </div>
                <Input type="password" placeholder="*********" {...field} />
              </Field>
            )}
          />

          <Button
            type="submit"
            variant={supportsPasskeys ? "outline" : "default"}
            className="w-full"
          >
            Sign in
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          Don't have an account?{" "}
          <Link
            to="/signup"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}
