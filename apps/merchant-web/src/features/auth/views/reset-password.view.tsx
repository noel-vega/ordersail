import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ApiError } from "merchant-sdk";
import { InfoIcon } from "lucide-react";
import { Field, FieldLabel } from "ui/field";
import { Input } from "ui/input";
import { Alert, AlertDescription, AlertTitle } from "ui/alert";
import { Button } from "ui/button";
import { ResetPasswordFormSchema, type ResetPasswordForm } from "../auth.api";
import { useResetPasswordMutation } from "../auth.hooks";

export function ResetPasswordView(props: { token?: string }) {
  const reset = useResetPasswordMutation();
  const navigate = useNavigate();
  const [linkInvalid, setLinkInvalid] = useState(!props.token);
  const [errorMessage, setErrorMessage] = useState("");

  const form = useForm<ResetPasswordForm>({
    resolver: zodResolver(ResetPasswordFormSchema),
    defaultValues: { password: "" },
  });

  function handleSubmit(data: ResetPasswordForm) {
    setErrorMessage("");
    if (!props.token) return setLinkInvalid(true);
    reset.mutate(
      { token: props.token, password: data.password },
      {
        // never logs in: the reset user's sessions are revoked server-side
        // and this browser is signed out (see useResetPasswordMutation), so
        // they sign in fresh — still passing MFA if they have it
        onSuccess: () => navigate({ to: "/signin", search: { reset: true } }),
        onError: (err) => {
          if (err instanceof ApiError && err.status === 401) {
            setLinkInvalid(true);
          } else if (err instanceof ApiError && err.status === 400) {
            // password policy (length/strength/breached) — the API's message
            setErrorMessage(err.message);
          } else if (err instanceof ApiError && err.status === 429) {
            setErrorMessage("Too many attempts — wait a minute and try again.");
          } else {
            setErrorMessage("Couldn't reset your password — try again.");
          }
        },
      },
    );
  }

  if (linkInvalid) {
    return (
      <div className="h-full flex items-center">
        <div className="max-w-sm mx-auto w-full space-y-6">
          <Alert variant="destructive">
            <InfoIcon />
            <AlertTitle>This link is invalid or has expired</AlertTitle>
            <AlertDescription>
              Reset links work once and expire after 1 hour. Request a new one
              to continue.
            </AlertDescription>
          </Alert>
          <Link to="/forgot-password">
            <Button type="button" className="w-full">
              Request a new link
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex items-center">
      <div className="max-w-sm mx-auto w-full space-y-8">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Choose a new password</h1>
          <p className="text-sm text-muted-foreground">
            You&apos;ll be signed out everywhere and asked to sign in again.
          </p>
        </div>

        {errorMessage && (
          <Alert variant="destructive">
            <InfoIcon />
            <AlertTitle>Couldn&apos;t update password</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <Controller
            control={form.control}
            name="password"
            render={({ field, fieldState }) => (
              <Field data-invalid={!!fieldState.error}>
                <FieldLabel>New password</FieldLabel>
                <Input
                  type="password"
                  autoComplete="new-password"
                  autoFocus
                  placeholder="At least 12 characters"
                  {...field}
                />
                {fieldState.error && (
                  <p className="text-sm text-destructive">
                    {fieldState.error.message}
                  </p>
                )}
              </Field>
            )}
          />
          <Button type="submit" className="w-full" disabled={reset.isPending}>
            {reset.isPending ? "Updating..." : "Update password"}
          </Button>
        </form>
      </div>
    </div>
  );
}
