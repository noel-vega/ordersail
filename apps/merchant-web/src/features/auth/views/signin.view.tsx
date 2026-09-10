import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import {
  SignInRequestBodySchema,
  type SignInRequestBody,
} from "../auth.api";
import { Field, FieldLabel } from "ui/field";
import { Input } from "ui/input";
import { Alert, AlertDescription, AlertTitle } from "ui/alert";
import { Button } from "ui/button";
import { useSignInMutation } from "../auth.hooks";
import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { InfoIcon } from "lucide-react";
import { AuthenticationError } from "../../../errors";
import { appConfig } from "../../../config";

export function SignInView() {
  const signInMutation = useSignInMutation();
  const navigate = useNavigate();
  const [errorMessage, setErrorMessage] = useState("");

  const form = useForm({
    resolver: zodResolver(SignInRequestBodySchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  function handleSubmit(formData: SignInRequestBody) {
    signInMutation.mutate(formData, {
      onError: (err) => {
        if (err instanceof AuthenticationError) {
          setErrorMessage("Invalid email or password.");
        }
      },
      onSuccess: () => {
        navigate({ to: appConfig.homeRoute });
      },
    });
  }

  function ErrorMessage() {
    if(!errorMessage) return null
    return (
      <Alert variant="destructive">
        <InfoIcon />
        <AlertTitle>Authentication Failed</AlertTitle>
        <AlertDescription>
          Invalid email or password.
        </AlertDescription>
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
                <FieldLabel>Password</FieldLabel>
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
