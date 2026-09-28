import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import {
  SignUpRequestBodySchema,
  type SignUpRequestBody,
} from "../auth.api";
import { Field, FieldLabel } from "ui/field";
import { Input } from "ui/input";
import { Alert, AlertDescription, AlertTitle } from "ui/alert";
import { Button } from "ui/button";
import { useSignUpMutation } from "../auth.hooks";
import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { InfoIcon } from "lucide-react";
import { appConfig } from "../../../config";
import { detectTimeZone } from "../../account/timezone";

export function SignUpView() {
  const signUpMutation = useSignUpMutation();
  const navigate = useNavigate();
  const [errorMessage, setErrorMessage] = useState("");

  const form = useForm({
    resolver: zodResolver(SignUpRequestBodySchema),
    defaultValues: {
      businessName: "",
      firstName: "",
      lastName: "",
      email: "",
      phone: "",
      password: "",
    },
  });

  async function handleSubmit(formData: SignUpRequestBody) {
    // the account's reporting timezone starts as this browser's (OS-667);
    // editable later in Settings
    signUpMutation.mutate({ ...formData, timezone: detectTimeZone() }, {
      onError: () => {
        setErrorMessage(
          "Unable to create account. This email may already be in use.",
        );
      },
      onSuccess: () => {
        navigate({ to: appConfig.homeRoute });
      },
    });
  }

  function ErrorMessage() {
    if (!errorMessage) return null;
    return (
      <Alert variant="destructive">
        <InfoIcon />
        <AlertTitle>Sign Up Failed</AlertTitle>
        <AlertDescription>{errorMessage}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="h-full flex items-center">
      <div className="max-w-sm mx-auto w-full space-y-8">
        <ErrorMessage />
        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <Controller
            control={form.control}
            name="businessName"
            render={({ field }) => (
              <Field>
                <FieldLabel>Business name</FieldLabel>
                <Input placeholder="Acme Inc." {...field} />
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name="firstName"
            render={({ field }) => (
              <Field>
                <FieldLabel>First name</FieldLabel>
                <Input placeholder="John" {...field} />
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name="lastName"
            render={({ field }) => (
              <Field>
                <FieldLabel>Last name</FieldLabel>
                <Input placeholder="Smith" {...field} />
              </Field>
            )}
          />

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
            name="phone"
            render={({ field, fieldState }) => (
              <Field data-invalid={!!fieldState.error}>
                <FieldLabel>Phone</FieldLabel>
                <Input type="tel" placeholder="(201) 555-0123" {...field} />
                {fieldState.error && (
                  <p className="text-sm text-destructive">{fieldState.error.message}</p>
                )}
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name="password"
            render={({ field }) => (
              <Field>
                <FieldLabel>Password</FieldLabel>
                <Input type="password" placeholder="*********" {...field} />
              </Field>
            )}
          />

          <Button type="submit" className="w-full">
            Sign up
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link
            to="/signin"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
