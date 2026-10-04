import { useState } from "react";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import z from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "ui/field";
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
import { Barcode, X } from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCreateProductMutation } from "../products.hooks";
import { BrandCombobox } from "../../brands/components/brand-combobox";
import { CategoryCombobox } from "../../categories/components/category-combobox";
import { centsToDollars, dollarsToCents } from "../../../lib/currency";
import { useStockLocations } from "../../locations/locations.hooks";
import { StockLocationSelect } from "../../locations/components/stock-location-select";

export const CreateProductFormSchema = z.object({
  name: z.string(),
  description: z.string(),
  status: z.union([
    z.literal("draft"),
    z.literal("active"),
    z.literal("archived"),
  ]),
  // useFieldArray needs an object per row (RHF doesn't support arrays of
  // primitives); flattened back to string[] before hitting the API.
  sku: z.string().nullable(),
  barcodes: z.object({ value: z.string() }).array(),
  priceCents: z.number(),
  stock: z.number(),
  // where the opening stock goes; only asked for with more than one location
  // (OS-696) — with one, the API uses it
  locationId: z.number().nullable(),
  brandId: z.number().nullable(),
  categoryIds: z.number().array(),
});

export type CreateProductForm = z.infer<typeof CreateProductFormSchema>;

// with more than one location, opening stock needs one picked
function createProductFormSchema(locationRequired: boolean) {
  return CreateProductFormSchema.superRefine((data, ctx) => {
    if (locationRequired && data.stock > 0 && data.locationId === null) {
      ctx.addIssue({
        code: "custom",
        path: ["locationId"],
        message: "Choose a location",
      });
    }
  });
}

export function CreateProductView() {
  const navigate = useNavigate();
  const createProduct = useCreateProductMutation();
  // opening stock needs a known location: with none yet the API refuses
  // stock above 0 (OS-689), and with several the merchant picks one (OS-696).
  // Until the list loads which case applies is unknown, so stock stays at 0
  // rather than risk a 400 the form couldn't resolve
  const stockLocations = useStockLocations();
  const { noLocation, multiLocation } = stockLocations;
  const canSetStock = stockLocations.isLoaded && !noLocation;
  const form = useForm({
    resolver: zodResolver(createProductFormSchema(multiLocation)),
    defaultValues: {
      name: "",
      description: "",
      status: "active" as const,
      sku: null,
      priceCents: 0,
      stock: 0,
      locationId: null,
      barcodes: [],
      brandId: null,
      categoryIds: [],
    },
  });

  const barcodeFields = useFieldArray({
    control: form.control,
    name: "barcodes",
  });

  const [barcodeInput, setBarcodeInput] = useState("");

  const handleBarcodeInputKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Enter") return;
    event.preventDefault();

    const code = barcodeInput.trim();
    if (code) {
      barcodeFields.append({ value: code });
    }
    setBarcodeInput("");
  };

  const handleSubmit = (data: CreateProductForm) => {
    const { brandId, locationId, ...rest } = data;
    if (!brandId) {
      return;
    }
    const barcodes = data.barcodes.map((b) => b.value);
    const sku = data.sku?.trim() || null;
    createProduct.mutate(
      {
        ...rest,
        brandId,
        barcodes,
        sku,
        locationId: locationId ?? undefined,
      },
      {
        onSuccess: () => {
          navigate({ to: "/app/products" });
        },
      },
    );
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Create Product</h1>
      <form
        onKeyDown={handleKeyDown}
        onSubmit={form.handleSubmit((data) => {
          handleSubmit(data);
        })}
        className="max-w-lg space-y-4"
      >
        <FieldGroup className="flex flex-row">
          <Controller
            control={form.control}
            name="name"
            render={({ field }) => (
              <Field>
                <FieldLabel>Name</FieldLabel>
                <Input autoFocus {...field} />
              </Field>
            )}
          />
        </FieldGroup>

        <Controller
          control={form.control}
          name="description"
          render={({ field }) => (
            <Field>
              <FieldLabel>Description</FieldLabel>
              <Textarea {...field} />
            </Field>
          )}
        />

        <Controller
          control={form.control}
          name="sku"
          render={({ field }) => (
            <Field>
              <FieldLabel>SKU</FieldLabel>
              <Input
                placeholder="e.g. SHOE-BLK-42"
                value={field.value ?? ""}
                onChange={(e) => field.onChange(e.currentTarget.value)}
              />
              <FieldDescription>
                Optional. Must be unique if provided.
              </FieldDescription>
            </Field>
          )}
        />

        <FieldGroup className="flex flex-row">
          <Controller
            control={form.control}
            name="priceCents"
            render={({ field }) => (
              <Field>
                <FieldLabel>Price</FieldLabel>
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  value={centsToDollars(field.value)}
                  onChange={(e) =>
                    field.onChange(dollarsToCents(e.currentTarget.valueAsNumber || 0))
                  }
                />
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name="stock"
            render={({ field }) => (
              <Field>
                <FieldLabel>Stock Quantity</FieldLabel>
                <Input
                  type="number"
                  value={field.value}
                  disabled={!canSetStock}
                  onChange={(e) =>
                    field.onChange(e.currentTarget.valueAsNumber)
                  }
                />
                {noLocation && (
                  <FieldDescription>
                    <Link to="/app/locations/create" className="underline">
                      Add a location
                    </Link>{" "}
                    first — stock needs somewhere to live.
                  </FieldDescription>
                )}
                {stockLocations.loadFailed && (
                  <FieldDescription>
                    Locations didn't load, so stock can't be set yet.{" "}
                    <button
                      type="button"
                      className="underline"
                      onClick={stockLocations.retry}
                    >
                      Retry
                    </button>
                  </FieldDescription>
                )}
              </Field>
            )}
          />

          {multiLocation && (
            <Controller
              control={form.control}
              name="locationId"
              render={({ field, fieldState }) => (
                <StockLocationSelect
                  label="Stock location"
                  locations={stockLocations.locations}
                  value={field.value}
                  onChange={field.onChange}
                  error={fieldState.error?.message}
                />
              )}
            />
          )}
        </FieldGroup>

        <FieldGroup className="flex flex-row">
          <Controller
            control={form.control}
            name="brandId"
            render={({ field }) => (
              <Field>
                <FieldLabel>Brand</FieldLabel>
                <BrandCombobox value={field.value} onValueChange={field.onChange} />
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name="categoryIds"
            render={({ field }) => (
              <Field>
                <FieldLabel>Categories</FieldLabel>
                <CategoryCombobox value={field.value} onValueChange={field.onChange} />
              </Field>
            )}
          />
        </FieldGroup>

        <Controller
          control={form.control}
          name="status"
          render={({ field }) => (
            <Field>
              <FieldLabel>Status</FieldLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="draft">draft</SelectItem>
                    <SelectItem value="active">active</SelectItem>
                    <SelectItem value="archived">archived</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          )}
        />
        <Field>
          <FieldLabel>Barcodes</FieldLabel>
          <Input
            placeholder="Click here, then scan a barcode"
            value={barcodeInput}
            onChange={(event) => setBarcodeInput(event.target.value)}
            onKeyDown={handleBarcodeInputKeyDown}
          />
          {barcodeFields.fields.length > 0 && (
            <ul className="space-y-1">
              {barcodeFields.fields.map((field, index) => (
                <li
                  key={field.id}
                  className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <Barcode className="text-muted-foreground" />
                    {form.watch(`barcodes.${index}.value`)}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remove barcode"
                    onClick={() => barcodeFields.remove(index)}
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Field>

        <Button type="submit">Submit</Button>
      </form>
    </div>
  );
}
