import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import z from "zod";
import { Field, FieldLabel } from "ui/field";
import { Input } from "ui/input";
import { Alert, AlertDescription, AlertTitle } from "ui/alert";
import { Button } from "ui/button";
import { useAcceptInviteMutation } from "../auth.hooks";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { InfoIcon } from "lucide-react";
import { appConfig } from "../../../config";
import {
  FactorSetupDialogs,
  FactorSetupOptions,
  useFactorSetup,
} from "../../passkeys/components/factor-setup";

const JoinFormSchema = z.object({
  password: z.string().min(8),
});

type JoinForm = z.infer<typeof JoinFormSchema>;

export function JoinView(props: { token: string }) {
  const acceptInvite = useAcceptInviteMutation();
  const navigate = useNavigate();
  const [errorMessage, setErrorMessage] = useState("");
  // non-null once the invite is accepted — the view then shows the factor
  // step in place of the password form (same view, no route change, like
  // signin's challenge step). Holds the password they just chose so the
  // authenticator flow doesn't immediately ask for it again; it lives only
  // as long as this view does.
  const [joinedPassword, setJoinedPassword] = useState<string | null>(null);

  // This step is a convenience, not the enforcement: accepting the invite
  // stamped users.factor_required_at, so leaving now lands on
  // /app/settings/security?required=true and every gated API call 403s
  // until a factor exists. Hence no "Not now".
  const factorSetup = useFactorSetup({
    onEnrolled: () => navigate({ to: appConfig.homeRoute }),
    knownPassword: joinedPassword ?? undefined,
  });

  const form = useForm<JoinForm>({
    resolver: zodResolver(JoinFormSchema),
    defaultValues: { password: "" },
  });

  function handleSubmit(formData: JoinForm) {
    acceptInvite.mutate(
      { token: props.token, password: formData.password },
      {
        onError: () => {
          setErrorMessage(
            "This invite link is invalid or has expired. Ask the account owner to resend it.",
          );
        },
        onSuccess: () => setJoinedPassword(formData.password),
      },
    );
  }

  function ErrorMessage() {
    if (!errorMessage) return null;
    return (
      <Alert variant="destructive">
        <InfoIcon />
        <AlertTitle>Couldn't join</AlertTitle>
        <AlertDescription>{errorMessage}</AlertDescription>
      </Alert>
    );
  }

  if (joinedPassword !== null) {
    return (
      <div className="h-full flex items-center">
        <div className="max-w-sm mx-auto w-full space-y-6">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">Secure your account</h1>
            <p className="text-sm text-muted-foreground">
              Password set. One more step before you reach the dashboard: add
              a passkey or an authenticator app so a password alone can&apos;t
              get into your team&apos;s store.
            </p>
          </div>
          <FactorSetupOptions setup={factorSetup} />
        </div>
        <FactorSetupDialogs setup={factorSetup} />
      </div>
    );
  }

  return (
    <div className="h-full flex items-center">
      <div className="max-w-sm mx-auto w-full space-y-8">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Set your password</h1>
          <p className="text-sm text-muted-foreground">
            Choose a password to finish joining your team on Ordersail.
          </p>
        </div>
        <ErrorMessage />
        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <Controller
            control={form.control}
            name="password"
            render={({ field, fieldState }) => (
              <Field data-invalid={!!fieldState.error}>
                <FieldLabel>Password</FieldLabel>
                <Input type="password" autoFocus placeholder="*********" {...field} />
                {fieldState.error && (
                  <p className="text-sm text-destructive">{fieldState.error.message}</p>
                )}
              </Field>
            )}
          />

          <Button type="submit" className="w-full" disabled={acceptInvite.isPending}>
            {acceptInvite.isPending ? "Joining..." : "Set password & continue"}
          </Button>
        </form>
      </div>
    </div>
  );
}
