import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import z from "zod";
import { ApiError } from "merchant-sdk";
import { Field, FieldLabel } from "ui/field";
import { Input } from "ui/input";
import { Button } from "ui/button";
import { toast } from "ui/sonner";
import { ResetPasswordFormSchema } from "../../auth/auth.api";
import { useChangePasswordMutation } from "../password.hooks";

// Taken from the reset-password form rather than restated, so the places a
// password gets chosen — signup, reset, here — can't drift apart. That floor
// is only the early client-side catch; the real strength and breach rejection
// is the API's (packages/password-policy) and arrives as a 400 below.
const newPassword = ResetPasswordFormSchema.shape.password;

const ChangePasswordFormSchema = z
  .object({
    // no strength rule on the current one — it was chosen under whatever
    // policy applied at the time, and holding it to today's would refuse a
    // password the server will happily accept
    currentPassword: z.string().min(1, "Required"),
    newPassword,
    confirmPassword: z.string(),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });

type ChangePasswordFormValues = z.infer<typeof ChangePasswordFormSchema>;

const EMPTY: ChangePasswordFormValues = {
  currentPassword: "",
  newPassword: "",
  confirmPassword: "",
};

// Changing your own password while signed in, against POST
// /auth/me/change-password. The current password is the re-authentication —
// the same bar disabling MFA and removing a passkey already apply — so this
// card carries no factor requirement of its own, which would otherwise lock
// out exactly the password-only users it exists for.
//
// Rendered unconditionally, including for a user whose `password` column is
// null. Nothing in the API tells the dashboard whether a password exists
// (neither AuthMe nor UserProfile carries such a flag), and there is no
// endpoint to set a first password — change-password requires a current one.
// So neither hiding the card nor a "set a password" variant is reachable
// today. What a password-less user gets instead is a working form that
// answers with an inline "Current password is incorrect", which is a poor
// message but not a broken form. Today every user is given a password at
// signup or accept-invite, so this stays hypothetical.
export function ChangePasswordCard() {
  const changePassword = useChangePasswordMutation();

  const form = useForm<ChangePasswordFormValues>({
    resolver: zodResolver(ChangePasswordFormSchema),
    defaultValues: EMPTY,
  });

  const handleSubmit = form.handleSubmit(async (values) => {
    try {
      await changePassword.mutateAsync({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      // nothing here is worth keeping, and leaving a password sitting in a
      // form field outlives the reason it was typed
      form.reset(EMPTY);
      toast.success("Password changed. Other devices have been signed out.");
    } catch (err) {
      if (!(err instanceof ApiError)) {
        form.setError("root", {
          message: "Couldn't change your password — try again.",
        });
        return;
      }

      // The API distinguishes these two deliberately, and each belongs
      // against the field that caused it rather than in a toast that doesn't
      // say which of the three inputs was wrong.
      if (err.status === 401) {
        // the current password didn't verify — never a stale access token,
        // which the SDK refreshes and retries before it ever reaches here
        form.setError("currentPassword", { message: err.message });
        return;
      }
      if (err.status === 400) {
        // the shared password policy refused the new one, with a message
        // written to be shown ("too weak", "appeared in a known data breach")
        form.setError("newPassword", { message: err.message });
        return;
      }

      // rate limiting (this route allows 3 attempts a minute) and anything
      // else the server says — not attributable to one field
      form.setError("root", { message: err.message });
    }
  });

  const rootError = form.formState.errors.root?.message;

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div>
        <h2 className="text-sm font-medium">Password</h2>
        <p className="text-sm text-muted-foreground">
          Changing it signs you out everywhere else. You'll stay signed in
          here.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Controller
          control={form.control}
          name="currentPassword"
          render={({ field, fieldState }) => (
            <Field data-invalid={!!fieldState.error}>
              <FieldLabel>Current password</FieldLabel>
              <Input
                type="password"
                autoComplete="current-password"
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

        <Controller
          control={form.control}
          name="newPassword"
          render={({ field, fieldState }) => (
            <Field data-invalid={!!fieldState.error}>
              <FieldLabel>New password</FieldLabel>
              <Input type="password" autoComplete="new-password" {...field} />
              {fieldState.error && (
                <p className="text-sm text-destructive">
                  {fieldState.error.message}
                </p>
              )}
            </Field>
          )}
        />

        <Controller
          control={form.control}
          name="confirmPassword"
          render={({ field, fieldState }) => (
            <Field data-invalid={!!fieldState.error}>
              <FieldLabel>Confirm new password</FieldLabel>
              <Input type="password" autoComplete="new-password" {...field} />
              {fieldState.error && (
                <p className="text-sm text-destructive">
                  {fieldState.error.message}
                </p>
              )}
            </Field>
          )}
        />

        {rootError && <p className="text-sm text-destructive">{rootError}</p>}

        <Button type="submit" disabled={changePassword.isPending}>
          {changePassword.isPending ? "Changing..." : "Change password"}
        </Button>
      </form>
    </div>
  );
}
