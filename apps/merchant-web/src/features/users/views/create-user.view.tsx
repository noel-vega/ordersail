import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import z from "zod";
import { useNavigate } from "@tanstack/react-router";
import { Field, FieldLabel } from "ui/field";
import { Input } from "ui/input";
import { Checkbox } from "ui/checkbox";
import { Label } from "ui/label";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import { useCreateUserMutation } from "../users.hooks";
import { useListRolesQuery } from "../../roles/roles.hooks";
import { phoneSchema, toE164 } from "../../../lib/phone";

const CreateUserFormSchema = z.object({
  firstName: z.string().min(1, "Required"),
  lastName: z.string().min(1, "Required"),
  phone: phoneSchema,
  email: z.email("Enter a valid email"),
  // optional — a user invited with no roles can still log in, they just
  // can't use anything gated by a permission until assigned one
  roleIds: z.array(z.number()),
});

type CreateUserForm = z.infer<typeof CreateUserFormSchema>;

export function CreateUserView() {
  const navigate = useNavigate();
  const createUser = useCreateUserMutation();
  const roles = useListRolesQuery();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const form = useForm<CreateUserForm>({
    resolver: zodResolver(CreateUserFormSchema),
    defaultValues: { firstName: "", lastName: "", phone: "", email: "", roleIds: [] },
  });

  const handleSubmit = form.handleSubmit((data) => {
    setSubmitError(null);
    createUser.mutate(
      {
        ...data,
        // the schema already proved it parses
        phone: toE164(data.phone)!,
        roleIds: data.roleIds.length > 0 ? data.roleIds : undefined,
      },
      {
        onSuccess: (result) => {
          if (!result) {
            setSubmitError("Couldn't add this user — check the role(s) you selected.");
            return;
          }
          navigate({ to: "/app/users" });
        },
      },
    );
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Add User</h1>
      <form onSubmit={handleSubmit} className="max-w-sm space-y-4">
        <Controller
          control={form.control}
          name="firstName"
          render={({ field, fieldState }) => (
            <Field data-invalid={!!fieldState.error}>
              <FieldLabel>First name</FieldLabel>
              <Input autoFocus {...field} />
              {fieldState.error && (
                <p className="text-sm text-destructive">{fieldState.error.message}</p>
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
              <Input {...field} />
              {fieldState.error && (
                <p className="text-sm text-destructive">{fieldState.error.message}</p>
              )}
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
          name="email"
          render={({ field, fieldState }) => (
            <Field data-invalid={!!fieldState.error}>
              <FieldLabel>Email</FieldLabel>
              <Input type="email" {...field} />
              {fieldState.error && (
                <p className="text-sm text-destructive">{fieldState.error.message}</p>
              )}
            </Field>
          )}
        />

        <Controller
          control={form.control}
          name="roleIds"
          render={({ field }) => (
            <Field>
              <FieldLabel>Roles</FieldLabel>
              {roles.data?.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No roles yet — you can assign one later.
                </p>
              )}
              <div className="space-y-2">
                {roles.data?.map((role) => (
                  <div key={role.id} className="flex items-center gap-2">
                    <Checkbox
                      checked={field.value.includes(role.id)}
                      disabled={role.isSystem}
                      onCheckedChange={(checked) =>
                        field.onChange(
                          checked
                            ? [...field.value, role.id]
                            : field.value.filter((id) => id !== role.id),
                        )
                      }
                    />
                    <Label>{role.name}</Label>
                    {role.isSystem && <Badge variant="secondary">System</Badge>}
                  </div>
                ))}
              </div>
            </Field>
          )}
        />

        {submitError && <p className="text-sm text-destructive">{submitError}</p>}

        <Button type="submit" disabled={createUser.isPending}>
          {createUser.isPending ? "Adding..." : "Add user"}
        </Button>
      </form>
    </div>
  );
}
