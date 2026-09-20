import { useEffect, type ReactNode } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import z from "zod";
import { Field, FieldLabel } from "ui/field";
import { Input } from "ui/input";
import { Button } from "ui/button";
import { LoaderCircleIcon } from "lucide-react";

// The three self-editable attributes of a user row — the Profile aspect in
// ADR 0001's split, as opposed to the Staff record (roles, status, invite
// lifecycle) that only an admin touches.
//
// This lives in components/ rather than features/users/ on purpose. Two very
// different pages render it: /app/me/profile, where you edit yourself, and
// /app/users/$id, where someone holding `users:write` edits a colleague. The
// personal page must not import from the staff-administration feature folder,
// or the two aspects stop being independently changeable.
//
// It owns no data access: each caller supplies the current values and the
// save, so the same fields can sit in front of `PATCH /auth/me/profile` on
// one page and `PATCH /users/:id` on the other.
export const ProfileFormSchema = z.object({
  firstName: z.string().min(1, "Required"),
  lastName: z.string().min(1, "Required"),
  phone: z.string(),
});

export type ProfileFormValues = z.infer<typeof ProfileFormSchema>;

export function ProfileForm(props: {
  values: ProfileFormValues;
  canEdit: boolean;
  isSaving: boolean;
  /**
   * Rejects to signal failure. Callers render their own error — inline, or
   * via the global mutation-error toast — so this component stays unopinionated
   * about how a save failure is reported.
   */
  onSave: (values: ProfileFormValues) => Promise<unknown>;
  /** Slot under the editable fields, e.g. the read-only sign-in email. */
  children?: ReactNode;
}) {
  const { firstName, lastName, phone } = props.values;
  const form = useForm<ProfileFormValues>({
    resolver: zodResolver(ProfileFormSchema),
    defaultValues: { firstName, lastName, phone },
  });

  // Re-seed when the server's values change (a refetch, or another tab's
  // edit). Depends on the three primitives rather than the object, which is
  // rebuilt by the caller on every render.
  useEffect(() => {
    form.reset({ firstName, lastName, phone });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstName, lastName, phone]);

  const handleSubmit = form.handleSubmit(async (values) => {
    try {
      await props.onSave(values);
      // clears isDirty so the Save button settles, without waiting on the
      // refetch that will re-seed the same values through the effect above
      form.reset(values);
    } catch {
      // the caller reports it; leave the form dirty so Save stays available
    }
  });

  return (
    <form onSubmit={handleSubmit} className="max-w-lg space-y-4">
      <Controller
        control={form.control}
        name="firstName"
        render={({ field, fieldState }) => (
          <Field data-invalid={!!fieldState.error}>
            <FieldLabel>First name</FieldLabel>
            <Input {...field} disabled={!props.canEdit} />
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
        name="lastName"
        render={({ field, fieldState }) => (
          <Field data-invalid={!!fieldState.error}>
            <FieldLabel>Last name</FieldLabel>
            <Input {...field} disabled={!props.canEdit} />
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
        name="phone"
        render={({ field }) => (
          <Field>
            <FieldLabel>Phone</FieldLabel>
            <Input
              type="tel"
              placeholder="(555) 555-5555"
              {...field}
              disabled={!props.canEdit}
            />
          </Field>
        )}
      />

      {props.children}

      {props.canEdit && (
        <Button
          type="submit"
          disabled={props.isSaving || !form.formState.isDirty}
        >
          {props.isSaving ? (
            <>
              <LoaderCircleIcon className="animate-spin" /> Saving...
            </>
          ) : (
            "Save"
          )}
        </Button>
      )}
    </form>
  );
}
