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
import { TimezoneCombobox } from "../components/timezone-combobox";
import { formatPhone, phoneSchema, toE164 } from "../../../lib/phone";

const ShippingContactFormSchema = z.object({
  phone: phoneSchema,
  email: z.email("Enter a valid email"),
});

type ShippingContactForm = z.infer<typeof ShippingContactFormSchema>;

const ReportingFormSchema = z.object({
  timezone: z.string().min(1, "Required"),
});

type ReportingForm = z.infer<typeof ReportingFormSchema>;

// same bounds as UpdateAccountDto (OS-668)
const InventoryFormSchema = z.object({
  lowStockThreshold: z
    .number({ error: "Enter a whole number" })
    .int("Enter a whole number")
    .min(0, "Can't be negative")
    .max(100000, "Must be 100,000 or less"),
});

type InventoryForm = z.infer<typeof InventoryFormSchema>;

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
      {account.data && (
        <ReportingForm timezone={account.data.timezone} canWrite={canWrite} />
      )}
      {account.data && (
        <InventoryForm
          lowStockThreshold={account.data.lowStockThreshold}
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
  // stored as E.164; shown the way the merchant would type it
  const phone = formatPhone(props.phone);
  const form = useForm<ShippingContactForm>({
    resolver: zodResolver(ShippingContactFormSchema),
    defaultValues: { phone, email: props.email },
  });

  useEffect(() => {
    form.reset({ phone, email: props.email });
  }, [phone, props.email]);

  const handleSubmit = form.handleSubmit((data) => {
    // errors surface as a toast (react-query-client MutationCache.onError).
    // The schema already proved the phone parses.
    updateAccount.mutate({ ...data, phone: toE164(data.phone)! });
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
              placeholder="(201) 555-0123"
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

function ReportingForm(props: { timezone: string; canWrite: boolean }) {
  const updateAccount = useUpdateAccountMutation();
  const form = useForm<ReportingForm>({
    resolver: zodResolver(ReportingFormSchema),
    defaultValues: { timezone: props.timezone },
  });

  useEffect(() => {
    form.reset({ timezone: props.timezone });
  }, [form, props.timezone]);

  const handleSubmit = form.handleSubmit((data) => {
    // errors surface as a toast (react-query-client MutationCache.onError)
    updateAccount.mutate(data);
  });

  return (
    <form onSubmit={handleSubmit} className="max-w-sm space-y-4">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">Reporting</h2>
        <p className="text-sm text-muted-foreground">
          The time zone your dashboard uses to decide where each day starts and
          ends, so everyone on your team sees the same totals.
        </p>
      </div>

      <Controller
        control={form.control}
        name="timezone"
        render={({ field, fieldState }) => (
          <Field data-invalid={!!fieldState.error}>
            <FieldLabel>Time zone</FieldLabel>
            <TimezoneCombobox
              value={field.value}
              onValueChange={field.onChange}
              disabled={!props.canWrite}
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

function InventoryForm(props: { lowStockThreshold: number; canWrite: boolean }) {
  const updateAccount = useUpdateAccountMutation();
  const form = useForm<InventoryForm>({
    resolver: zodResolver(InventoryFormSchema),
    defaultValues: { lowStockThreshold: props.lowStockThreshold },
  });

  useEffect(() => {
    form.reset({ lowStockThreshold: props.lowStockThreshold });
  }, [form, props.lowStockThreshold]);

  const handleSubmit = form.handleSubmit((data) => {
    // errors surface as a toast (react-query-client MutationCache.onError)
    updateAccount.mutate(data);
  });

  return (
    <form onSubmit={handleSubmit} className="max-w-sm space-y-4">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">Inventory</h2>
        <p className="text-sm text-muted-foreground">
          Stock at or below this quantity is flagged as low. At 0 or below
          it's out of stock.
        </p>
      </div>

      <Controller
        control={form.control}
        name="lowStockThreshold"
        render={({ field, fieldState }) => (
          <Field data-invalid={!!fieldState.error}>
            <FieldLabel>Low-stock threshold</FieldLabel>
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              disabled={!props.canWrite}
              name={field.name}
              ref={field.ref}
              onBlur={field.onBlur}
              value={Number.isNaN(field.value) ? "" : field.value}
              onChange={(e) => field.onChange(e.target.valueAsNumber)}
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
