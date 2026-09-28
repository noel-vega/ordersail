import { Controller, FormProvider, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import z from "zod";
import { useNavigate } from "@tanstack/react-router";
import { Field, FieldLabel } from "ui/field";
import { Input } from "ui/input";
import { Button } from "ui/button";
import { useCreateLocationMutation } from "../locations.hooks";
import { ShipFromFields } from "../ship-from-fields";
import {
  shipFromDefaults,
  shipFromFormSchema,
  toShipFromBody,
} from "../ship-from";

const CreateLocationFormSchema = shipFromFormSchema.extend({
  name: z.string().min(1, "Required"),
});

export function CreateLocationView() {
  const navigate = useNavigate();
  const createLocation = useCreateLocationMutation();
  const form = useForm<
    z.input<typeof CreateLocationFormSchema>,
    unknown,
    z.output<typeof CreateLocationFormSchema>
  >({
    resolver: zodResolver(CreateLocationFormSchema),
    defaultValues: { name: "", ...shipFromDefaults() },
  });

  const handleSubmit = form.handleSubmit(({ name, ...shipFrom }) => {
    createLocation.mutate(
      { name, ...toShipFromBody(shipFrom) },
      {
        onSuccess: () => {
          navigate({ to: "/app/locations" });
        },
      },
    );
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Create Location</h1>
      <FormProvider {...form}>
        <form onSubmit={handleSubmit} className="max-w-sm space-y-4">
          <Controller
            control={form.control}
            name="name"
            render={({ field, fieldState }) => (
              <Field data-invalid={!!fieldState.error}>
                <FieldLabel>Name</FieldLabel>
                <Input autoFocus placeholder="e.g. Warehouse" {...field} />
                {fieldState.error && (
                  <p className="text-sm text-destructive">
                    {fieldState.error.message}
                  </p>
                )}
              </Field>
            )}
          />

          <div className="space-y-1 pt-2">
            <h2 className="font-medium">Ship-from details</h2>
            <p className="text-sm text-muted-foreground">
              Optional for a stock-only location. Needed before you can buy
              shipping labels from it.
            </p>
          </div>
          <ShipFromFields />

          <Button type="submit" disabled={createLocation.isPending}>
            {createLocation.isPending ? "Creating..." : "Create"}
          </Button>
        </form>
      </FormProvider>
    </div>
  );
}
