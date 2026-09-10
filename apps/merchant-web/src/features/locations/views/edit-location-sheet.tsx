import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import z from "zod";
import type { Location } from "merchant-sdk";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "ui/sheet";
import { Field, FieldLabel } from "ui/field";
import { Input } from "ui/input";
import { Button } from "ui/button";
import { LoaderCircleIcon } from "lucide-react";
import { useUpdateLocationMutation } from "../locations.hooks";

const EditLocationFormSchema = z.object({
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  addressCity: z.string().nullable(),
  addressState: z.string().nullable(),
  addressPostalCode: z.string().nullable(),
  addressCountry: z.string().nullable(),
});

type EditLocationForm = z.infer<typeof EditLocationFormSchema>;

export function EditLocationSheet(props: {
  location: Location | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Edit address</SheetTitle>
          <SheetDescription>
            Used as the ship-from origin when quoting shipping rates.
          </SheetDescription>
        </SheetHeader>
        {props.open && props.location && (
          <EditLocationForm
            location={props.location}
            onDone={() => props.onOpenChange(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

// mounted only while the sheet is open, so defaultValues are always a fresh
// snapshot of the location
function EditLocationForm(props: { location: Location; onDone: () => void }) {
  const updateLocation = useUpdateLocationMutation();
  const form = useForm<EditLocationForm>({
    resolver: zodResolver(EditLocationFormSchema),
    defaultValues: {
      addressLine1: props.location.addressLine1,
      addressLine2: props.location.addressLine2,
      addressCity: props.location.addressCity,
      addressState: props.location.addressState,
      addressPostalCode: props.location.addressPostalCode,
      addressCountry: props.location.addressCountry,
    },
  });

  const handleSubmit = form.handleSubmit((data) => {
    updateLocation.mutate(
      {
        id: props.location.id,
        addressLine1: data.addressLine1?.trim() || null,
        addressLine2: data.addressLine2?.trim() || null,
        addressCity: data.addressCity?.trim() || null,
        addressState: data.addressState?.trim() || null,
        addressPostalCode: data.addressPostalCode?.trim() || null,
        addressCountry: data.addressCountry?.trim() || null,
      },
      // errors surface as a toast; only close the sheet on success
      { onSuccess: () => props.onDone() },
    );
  });

  return (
    <form onSubmit={handleSubmit} className="flex flex-1 flex-col">
      <div className="flex-1 space-y-4 px-4">
        <Controller
          control={form.control}
          name="addressLine1"
          render={({ field }) => (
            <Field>
              <FieldLabel>Address line 1</FieldLabel>
              <Input
                placeholder="123 Main St"
                value={field.value ?? ""}
                onChange={(e) => field.onChange(e.currentTarget.value)}
              />
            </Field>
          )}
        />

        <Controller
          control={form.control}
          name="addressLine2"
          render={({ field }) => (
            <Field>
              <FieldLabel>Address line 2</FieldLabel>
              <Input
                placeholder="Suite 100"
                value={field.value ?? ""}
                onChange={(e) => field.onChange(e.currentTarget.value)}
              />
            </Field>
          )}
        />

        <Controller
          control={form.control}
          name="addressCity"
          render={({ field }) => (
            <Field>
              <FieldLabel>City</FieldLabel>
              <Input
                value={field.value ?? ""}
                onChange={(e) => field.onChange(e.currentTarget.value)}
              />
            </Field>
          )}
        />

        <Controller
          control={form.control}
          name="addressState"
          render={({ field }) => (
            <Field>
              <FieldLabel>State</FieldLabel>
              <Input
                placeholder="CA"
                value={field.value ?? ""}
                onChange={(e) => field.onChange(e.currentTarget.value)}
              />
            </Field>
          )}
        />

        <Controller
          control={form.control}
          name="addressPostalCode"
          render={({ field }) => (
            <Field>
              <FieldLabel>Postal code</FieldLabel>
              <Input
                value={field.value ?? ""}
                onChange={(e) => field.onChange(e.currentTarget.value)}
              />
            </Field>
          )}
        />

        <Controller
          control={form.control}
          name="addressCountry"
          render={({ field }) => (
            <Field>
              <FieldLabel>Country</FieldLabel>
              <Input
                placeholder="US"
                value={field.value ?? ""}
                onChange={(e) => field.onChange(e.currentTarget.value.toUpperCase())}
              />
            </Field>
          )}
        />
      </div>

      <SheetFooter className="flex-row justify-end">
        <Button
          type="button"
          variant="outline"
          disabled={updateLocation.isPending}
          onClick={props.onDone}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={updateLocation.isPending}>
          {updateLocation.isPending ? (
            <>
              <LoaderCircleIcon className="animate-spin" /> Saving...
            </>
          ) : (
            "Save"
          )}
        </Button>
      </SheetFooter>
    </form>
  );
}
