import { Controller, useFormContext } from "react-hook-form";
import { Field, FieldLabel } from "ui/field";
import { Input } from "ui/input";
import type { ShipFromFormInput } from "./ship-from";

// the ship-from inputs for the create form and the edit sheet — see
// ./ship-from for the schema and the request-body mapping
const ADDRESS_FIELDS = [
  { name: "addressLine1", label: "Address line 1", placeholder: "123 Main St" },
  { name: "addressLine2", label: "Address line 2", placeholder: "Suite 100" },
  { name: "addressCity", label: "City" },
  { name: "addressState", label: "State", placeholder: "CA" },
  { name: "addressPostalCode", label: "Postal code" },
] as const;

// renders inside a <FormProvider> whose form includes shipFromFormSchema's keys
export function ShipFromFields() {
  const { control } = useFormContext<ShipFromFormInput>();

  return (
    <>
      {ADDRESS_FIELDS.map((f) => (
        <Controller
          key={f.name}
          control={control}
          name={f.name}
          render={({ field }) => (
            <Field>
              <FieldLabel>{f.label}</FieldLabel>
              <Input
                placeholder={"placeholder" in f ? f.placeholder : undefined}
                {...field}
              />
            </Field>
          )}
        />
      ))}

      <Controller
        control={control}
        name="addressCountry"
        render={({ field }) => (
          <Field>
            <FieldLabel>Country</FieldLabel>
            <Input
              placeholder="US"
              {...field}
              onChange={(e) => field.onChange(e.currentTarget.value.toUpperCase())}
            />
          </Field>
        )}
      />

      <Controller
        control={control}
        name="phone"
        render={({ field, fieldState }) => (
          <Field data-invalid={!!fieldState.error}>
            <FieldLabel>Phone</FieldLabel>
            <Input type="tel" placeholder="(201) 555-0123" {...field} />
            <p className="text-sm text-muted-foreground">
              Carriers like USPS require one to buy a label from here.
            </p>
            {fieldState.error && (
              <p className="text-sm text-destructive">{fieldState.error.message}</p>
            )}
          </Field>
        )}
      />
    </>
  );
}
