import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import z from "zod";
import type { Brand } from "merchant-sdk";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "ui/sheet";
import { Field, FieldLabel } from "ui/field";
import { Input } from "ui/input";
import { Button } from "ui/button";
import { LoaderCircleIcon } from "lucide-react";
import { useUpdateBrandMutation } from "../brands.hooks";

const EditBrandFormSchema = z.object({
  name: z.string().min(1, "Required"),
});

type EditBrandForm = z.infer<typeof EditBrandFormSchema>;

export function EditBrandSheet(props: {
  brand: Brand | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Edit brand</SheetTitle>
        </SheetHeader>
        {props.open && props.brand && (
          <EditBrandForm
            brand={props.brand}
            onDone={() => props.onOpenChange(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

// mounted only while the sheet is open, so defaultValues are always a fresh
// snapshot of the brand
function EditBrandForm(props: { brand: Brand; onDone: () => void }) {
  const updateBrand = useUpdateBrandMutation();
  const form = useForm<EditBrandForm>({
    resolver: zodResolver(EditBrandFormSchema),
    defaultValues: { name: props.brand.name },
  });

  const handleSubmit = form.handleSubmit((data) => {
    updateBrand.mutate(
      { id: props.brand.id, name: data.name },
      { onSuccess: () => props.onDone() },
    );
  });

  return (
    <form onSubmit={handleSubmit} className="flex flex-1 flex-col">
      <div className="flex-1 space-y-4 px-4">
        <Controller
          control={form.control}
          name="name"
          render={({ field, fieldState }) => (
            <Field data-invalid={!!fieldState.error}>
              <FieldLabel>Name</FieldLabel>
              <Input {...field} />
              {fieldState.error && (
                <p className="text-sm text-destructive">
                  {fieldState.error.message}
                </p>
              )}
            </Field>
          )}
        />
      </div>

      <SheetFooter className="flex-row justify-end">
        <Button
          type="button"
          variant="outline"
          disabled={updateBrand.isPending}
          onClick={props.onDone}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={updateBrand.isPending}>
          {updateBrand.isPending ? (
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
