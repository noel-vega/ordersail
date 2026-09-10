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
import { useNavigate } from "@tanstack/react-router";
import { useCreateProductMutation } from "../products.hooks";
import { BrandCombobox } from "../../brands/components/brand-combobox";
import { CategoryCombobox } from "../../categories/components/category-combobox";
import { centsToDollars, dollarsToCents } from "../../../lib/currency";

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
  brandId: z.number().nullable(),
  categoryIds: z.number().array(),
});

export type CreateProductForm = z.infer<typeof CreateProductFormSchema>;

export function CreateProductView() {
  const navigate = useNavigate();
  const createProduct = useCreateProductMutation();
  const form = useForm({
    resolver: zodResolver(CreateProductFormSchema),
    defaultValues: {
      name: "",
      description: "",
      status: "active" as const,
      sku: null,
      priceCents: 0,
      stock: 0,
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
    const { brandId, ...rest } = data;
    if (!brandId) {
      return;
    }
    const barcodes = data.barcodes.map((b) => b.value);
    const sku = data.sku?.trim() || null;
    createProduct.mutate(
      { ...rest, brandId, barcodes, sku },
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
                  onChange={(e) =>
                    field.onChange(e.currentTarget.valueAsNumber)
                  }
                />
              </Field>
            )}
          />
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
