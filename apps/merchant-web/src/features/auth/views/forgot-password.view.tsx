import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ApiError } from "merchant-sdk";
import { InfoIcon, MailIcon } from "lucide-react";
import { Field, FieldLabel } from "ui/field";
import { Input } from "ui/input";
import { Alert, AlertDescription, AlertTitle } from "ui/alert";
import { Button } from "ui/button";
import {
  ForgotPasswordRequestBodySchema,
  type ForgotPasswordRequestBody,
} from "../auth.api";
import { useForgotPasswordMutation } from "../auth.hooks";

export function ForgotPasswordView() {
  const forgot = useForgotPasswordMutation();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState("");

  const form = useForm<ForgotPasswordRequestBody>({
    resolver: zodResolver(ForgotPasswordRequestBodySchema),
    defaultValues: { email: "" },
  });

  function handleSubmit(data: ForgotPasswordRequestBody) {
    setErrorMessage("");
    forgot.mutate(data, {
      // the API answers identically for registered and unknown emails —
      // so does this screen
      onSuccess: () => setSentTo(data.email),
      onError: (err) =>
        setErrorMessage(
          err instanceof ApiError && err.status === 429
            ? "Too many requests — wait a minute and try again."
            : "Couldn't send the reset email — try again.",
        ),
    });
  }

  return (
    <div className="h-full flex items-center">
      <div className="max-w-sm mx-auto w-full space-y-8">
        {sentTo ? (
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <MailIcon />
            </div>
            <div className="space-y-1">
              <h1 className="text-xl font-semibold">Check your email</h1>
              <p className="text-sm text-muted-foreground">
                If <span className="font-medium text-foreground">{sentTo}</span>{" "}
                has an Ordersail account, we sent a link to reset the password.
                It expires in 1 hour.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-1">
              <h1 className="text-xl font-semibold">Reset your password</h1>
              <p className="text-sm text-muted-foreground">
                Enter your account email and we&apos;ll send you a reset link.
              </p>
            </div>

            {errorMessage && (
              <Alert variant="destructive">
                <InfoIcon />
                <AlertTitle>Something went wrong</AlertTitle>
                <AlertDescription>{errorMessage}</AlertDescription>
              </Alert>
            )}

            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
              <Controller
                control={form.control}
                name="email"
                render={({ field, fieldState }) => (
                  <Field data-invalid={!!fieldState.error}>
                    <FieldLabel>Email</FieldLabel>
                    <Input
                      type="email"
                      autoFocus
                      placeholder="john.smith@example.com"
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
              <Button type="submit" className="w-full" disabled={forgot.isPending}>
                {forgot.isPending ? "Sending..." : "Send reset link"}
              </Button>
            </form>
          </>
        )}

        <p className="text-center text-sm text-muted-foreground">
          <Link
            to="/signin"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
