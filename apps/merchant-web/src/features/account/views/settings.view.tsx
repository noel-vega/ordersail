import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import z from "zod";
import { Field, FieldLabel } from "ui/field";
import { Input } from "ui/input";
import { Button } from "ui/button";
import { LoaderCircleIcon } from "lucide-react";
import { useAccountQuery, useUpdateAccountMutation } from "../account.hooks";
import { usePermissions } from "../../auth/permission-context";

const ShippingContactFormSchema = z.object({
  phone: z.string().min(1, "Required"),
  email: z.email("Enter a valid email"),
});

type ShippingContactForm = z.infer<typeof ShippingContactFormSchema>;

export function SettingsView() {
  const account = useAccountQuery();
  const canWrite = usePermissions().has("account:write");

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Settings</h1>
      {account.data && (
        <ShippingContactForm
          phone={account.data.phone}
          email={account.data.email}
          canWrite={canWrite}
        />
      )}
    </div>
  );
}

// remounted (via key, see below) whenever the loaded account changes, so
// defaultValues are always a fresh snapshot
function ShippingContactForm(props: {
  phone: string;
  email: string;
  canWrite: boolean;
}) {
  const updateAccount = useUpdateAccountMutation();
  const form = useForm<ShippingContactForm>({
    resolver: zodResolver(ShippingContactFormSchema),
    defaultValues: { phone: props.phone, email: props.email },
  });

  useEffect(() => {
    form.reset({ phone: props.phone, email: props.email });
  }, [props.phone, props.email]);

  const handleSubmit = form.handleSubmit((data) => {
    // errors surface as a toast (react-query-client MutationCache.onError)
    updateAccount.mutate(data);
  });

  return (
    <form onSubmit={handleSubmit} className="max-w-sm space-y-4">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">Shipping contact</h2>
        <p className="text-sm text-muted-foreground">
          Given to carriers as the sender's contact info when purchasing labels. Some
          carriers, like USPS, require it.
        </p>
      </div>

      <Controller
        control={form.control}
        name="phone"
        render={({ field, fieldState }) => (
          <Field data-invalid={!!fieldState.error}>
            <FieldLabel>Phone</FieldLabel>
            <Input
              type="tel"
              placeholder="(555) 555-5555"
              disabled={!props.canWrite}
              {...field}
            />
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
            <Input
              type="email"
              placeholder="shipping@example.com"
              disabled={!props.canWrite}
              {...field}
            />
            {fieldState.error && (
              <p className="text-sm text-destructive">{fieldState.error.message}</p>
            )}
          </Field>
        )}
      />

      {props.canWrite && (
        <Button type="submit" disabled={updateAccount.isPending}>
          {updateAccount.isPending ? (
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
