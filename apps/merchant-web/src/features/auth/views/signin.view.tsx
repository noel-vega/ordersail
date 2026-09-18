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
import { InfoIcon } from "lucide-react";
import { safeRedirectPath } from "../safe-redirect";

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

          <Button type="submit" className="w-full">
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
