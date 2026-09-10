import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import z from "zod";
import { formatDistanceToNow } from "date-fns";
import { Button } from "ui/button";
import { Field, FieldLabel } from "ui/field";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "ui/alert-dialog";
import { ArrowLeftIcon, LoaderCircleIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import {
  useDeleteProductMutation,
  useProductQuery,
  useUpdateProductMutation,
} from "../products.hooks";
import { useProductInventoryQuery } from "../../inventory/inventory.hooks";
import { BrandCombobox } from "../../brands/components/brand-combobox";
import { CategoryCombobox } from "../../categories/components/category-combobox";
import { VariantSection } from "../variant-section";
import { ProductInventoryTab } from "./product-inventory-tab";
import { ProductImagesTab } from "./product-images-tab";
import { Separator } from "ui/separator";


const DetailsFormSchema = z.object({
  status: z.union([z.literal("draft"), z.literal("active"), z.literal("archived")]),
  name: z.string().min(1, "Required"),
  description: z.string(),
  brandId: z.number().nullable(),
  categoryIds: z.number().array(),
});

type DetailsForm = z.infer<typeof DetailsFormSchema>;

export function ProductView({ id }: { id: number }) {
  const navigate = useNavigate();
  const { data } = useProductQuery(id);
  const { data: inventory } = useProductInventoryQuery(id);
  const deleteProduct = useDeleteProductMutation();
  const updateProduct = useUpdateProductMutation(id);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const detailsForm = useForm<DetailsForm>({
    resolver: zodResolver(DetailsFormSchema),
    mode: "onChange",
    defaultValues: {
      status: "draft",
      name: "",
      description: "",
      brandId: null,
      categoryIds: [],
    },
  });

  useEffect(() => {
    if (!data) return;
    // don't clobber in-progress edits with a background refetch
    if (detailsForm.formState.isDirty) return;
    detailsForm.reset({
      status: data.status,
      name: data.name,
      description: data.description ?? "",
      brandId: data.brand?.id ?? null,
      categoryIds: data.categoryIds ?? [],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  if (!data) {
    return null;
  }

  const productInventory = (inventory?.items ?? []).filter(
    (record) => record.productId === id,
  );
  const handleDelete = () => {
    deleteProduct.mutate(id, {
      onSuccess: () => {
        navigate({ to: "/app/products" });
      },
    });
  };

  const handleDetailsSubmit = detailsForm.handleSubmit(async (values) => {
    await updateProduct.mutateAsync(values);
    // re-baseline on the just-saved values so the form goes clean again
    detailsForm.reset(values);
  });

  const { isDirty, isValid } = detailsForm.formState;

  return (
    <div>
      <header className="mb-8">
        <div className="flex items-start gap-3">
          <Link to="/app/products">
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Back to products">
              <ArrowLeftIcon />
            </Button>
          </Link>
          <div className="flex-1">
            <h1 className="text-lg font-semibold">{data.name}</h1>
            <p className="text-sm text-muted-foreground">
              Last edited{" "}
              {formatDistanceToNow(new Date(data.updatedAt), { addSuffix: true })}
            </p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Product settings"
                />
              }
            >
              <SettingsIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setDeleteDialogOpen(true)}
              >
                <Trash2Icon /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{data.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this product and all of its variants.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteProduct.isPending}
              onClick={handleDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Tabs defaultValue="details" className="gap-0">
        <TabsList variant="line">
          <TabsTrigger value="details" className="px-4">Details</TabsTrigger>
          <TabsTrigger value="variants" className="px-4">
            Variants & Pricing
          </TabsTrigger>
          <TabsTrigger value="inventory" className="px-4">Inventory</TabsTrigger>
          <TabsTrigger value="images" className="px-4">Images</TabsTrigger>
        </TabsList>
        <Separator className="mt-0" />

        <TabsContent value="details" className="pt-6">
          <form onSubmit={handleDetailsSubmit} className="max-w-lg space-y-4">
            <Controller
              control={detailsForm.control}
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
            <Controller
              control={detailsForm.control}
              name="name"
              render={({ field, fieldState }) => (
                <Field data-invalid={!!fieldState.error}>
                  <FieldLabel>Product name</FieldLabel>
                  <Input {...field} />
                  {fieldState.error && (
                    <p className="text-sm text-destructive">{fieldState.error.message}</p>
                  )}
                </Field>
              )}
            />
            <Controller
              control={detailsForm.control}
              name="description"
              render={({ field }) => (
                <Field>
                  <FieldLabel>Description</FieldLabel>
                  <Textarea {...field} />
                </Field>
              )}
            />
            <Controller
              control={detailsForm.control}
              name="brandId"
              render={({ field }) => (
                <Field>
                  <FieldLabel>Brand</FieldLabel>
                  <BrandCombobox value={field.value} onValueChange={field.onChange} />
                </Field>
              )}
            />
            <Controller
              control={detailsForm.control}
              name="categoryIds"
              render={({ field }) => (
                <Field>
                  <FieldLabel>Categories</FieldLabel>
                  <CategoryCombobox value={field.value} onValueChange={field.onChange} />
                </Field>
              )}
            />

            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                disabled={!isDirty || updateProduct.isPending}
                onClick={() => detailsForm.reset()}
              >
                Reset
              </Button>
              <Button type="submit" disabled={!isDirty || !isValid || updateProduct.isPending}>
                {updateProduct.isPending ? (
                  <>
                    <LoaderCircleIcon className="animate-spin" /> Saving...
                  </>
                ) : (
                  "Save"
                )}
              </Button>
            </div>
          </form>
        </TabsContent>

        <TabsContent value="variants" className="pt-6">
          <VariantSection productId={id} productName={data.name} />
        </TabsContent>

        <TabsContent value="inventory" className="pt-6">
          <ProductInventoryTab records={productInventory} />
        </TabsContent>

        <TabsContent value="images" className="pt-6">
          <ProductImagesTab productId={id} images={data.images} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
