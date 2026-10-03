import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import z from "zod";
import { fixedLocation, type AdjustStockTarget } from "./adjust-stock-target";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "ui/sheet";
import { Field, FieldLabel } from "ui/field";
import { StockLocationSelect } from "../../locations/components/stock-location-select";
import { Input } from "ui/input";
import { Textarea } from "ui/textarea";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "ui/select";
import { Button } from "ui/button";
import { LoaderCircleIcon, MinusIcon, PlusIcon } from "lucide-react";
import { cn } from "ui/utils";
import { useCreateInventoryMovementMutation } from "../inventory.hooks";

const IN_REASONS: readonly string[] = ["received", "return", "adjustment"];
const OUT_REASONS: readonly string[] = ["sold", "damaged", "adjustment"];

const AdjustStockFormSchema = z.object({
  // null until the merchant picks one — with several locations it's never
  // guessed (OS-696)
  locationId: z.number().nullable().refine((id) => id !== null, "Choose a location"),
  direction: z.union([z.literal("in"), z.literal("out")]),
  quantity: z.number().int().positive("Must be at least 1"),
  reason: z.union([
    z.literal("received"),
    z.literal("sold"),
    z.literal("return"),
    z.literal("damaged"),
    z.literal("adjustment"),
  ]),
  note: z.string(),
});

export function AdjustStockSheet(props: {
  target: AdjustStockTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const target = props.target;
  const pinned = target && fixedLocation(target);
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Adjust stock</SheetTitle>
          <SheetDescription>
            {target
              ? `${target.productName}${target.sku ? ` (${target.sku})` : ""}${pinned ? ` at ${pinned.name}` : ""}`
              : ""}
          </SheetDescription>
        </SheetHeader>
        {props.open && target && (
          <AdjustStockForm
            target={target}
            onDone={() => props.onOpenChange(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

// mounted only while the sheet is open, so it always starts from a clean draft
function AdjustStockForm(props: { target: AdjustStockTarget; onDone: () => void }) {
  const createMovement = useCreateInventoryMovementMutation();
  const { locations } = props.target;
  const form = useForm<
    z.input<typeof AdjustStockFormSchema>,
    unknown,
    z.output<typeof AdjustStockFormSchema>
  >({
    resolver: zodResolver(AdjustStockFormSchema),
    defaultValues: {
      locationId: fixedLocation(props.target)?.id ?? null,
      direction: "in",
      quantity: 1,
      reason: "received",
      note: "",
    },
  });
  const [error, setError] = useState<string | null>(null);

  const direction = form.watch("direction");
  const reasonOptions = direction === "in" ? IN_REASONS : OUT_REASONS;
  const selected = locations.find((l) => l.id === form.watch("locationId"));

  const handleSubmit = form.handleSubmit(async (data) => {
    setError(null);
    const delta = data.direction === "in" ? data.quantity : -data.quantity;
    try {
      await createMovement.mutateAsync({
        variantId: props.target.variantId,
        locationId: data.locationId,
        delta,
        reason: data.reason,
        note: data.note.trim() || null,
      });
      props.onDone();
    } catch {
      setError("Failed to save. Please try again.");
    }
  });

  return (
    <form onSubmit={handleSubmit} className="flex flex-1 flex-col">
      <div className="flex-1 space-y-4 px-4">
        {!fixedLocation(props.target) && (
          <Controller
            control={form.control}
            name="locationId"
            render={({ field, fieldState }) => (
              <StockLocationSelect
                label="Location"
                locations={locations}
                value={field.value}
                onChange={field.onChange}
                error={fieldState.error?.message}
              />
            )}
          />
        )}

        {selected && selected.stock != null && (
          <Field>
            <FieldLabel>Current stock</FieldLabel>
            <p className="text-sm text-muted-foreground">{selected.stock}</p>
          </Field>
        )}

        <Controller
          control={form.control}
          name="direction"
          render={({ field }) => (
            <Field>
              <FieldLabel>Direction</FieldLabel>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className={cn(
                    field.value === "in" &&
                      "border-primary bg-primary/5 text-primary",
                  )}
                  onClick={() => {
                    field.onChange("in");
                    if (!IN_REASONS.includes(form.getValues("reason"))) {
                      form.setValue("reason", "received");
                    }
                  }}
                >
                  <PlusIcon /> Stock in
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className={cn(
                    field.value === "out" &&
                      "border-primary bg-primary/5 text-primary",
                  )}
                  onClick={() => {
                    field.onChange("out");
                    if (!OUT_REASONS.includes(form.getValues("reason"))) {
                      form.setValue("reason", "sold");
                    }
                  }}
                >
                  <MinusIcon /> Stock out
                </Button>
              </div>
            </Field>
          )}
        />

        <Controller
          control={form.control}
          name="quantity"
          render={({ field, fieldState }) => (
            <Field data-invalid={!!fieldState.error}>
              <FieldLabel>Quantity</FieldLabel>
              <Input
                type="number"
                min={1}
                value={field.value}
                onChange={(e) => field.onChange(e.currentTarget.valueAsNumber)}
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
          name="reason"
          render={({ field }) => (
            <Field>
              <FieldLabel>Reason</FieldLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {reasonOptions.map((reason) => (
                      <SelectItem key={reason} value={reason}>
                        {reason}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          )}
        />

        <Controller
          control={form.control}
          name="note"
          render={({ field }) => (
            <Field>
              <FieldLabel>Note (optional)</FieldLabel>
              <Textarea placeholder="e.g. PO #1234" {...field} />
            </Field>
          )}
        />

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      <SheetFooter className="flex-row justify-end">
        <Button
          type="button"
          variant="outline"
          disabled={createMovement.isPending}
          onClick={props.onDone}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={createMovement.isPending}>
          {createMovement.isPending ? (
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
