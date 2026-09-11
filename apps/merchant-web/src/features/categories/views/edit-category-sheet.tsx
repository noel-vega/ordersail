import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import z from "zod";
import type { Category } from "merchant-sdk";
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
import { useUpdateCategoryMutation } from "../categories.hooks";

const EditCategoryFormSchema = z.object({
  name: z.string().min(1, "Required"),
});

type EditCategoryForm = z.infer<typeof EditCategoryFormSchema>;

export function EditCategorySheet(props: {
  category: Category | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Edit category</SheetTitle>
        </SheetHeader>
        {props.open && props.category && (
          <EditCategoryForm
            category={props.category}
            onDone={() => props.onOpenChange(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

// mounted only while the sheet is open, so defaultValues are always a fresh
// snapshot of the category
function EditCategoryForm(props: { category: Category; onDone: () => void }) {
  const updateCategory = useUpdateCategoryMutation();
  const form = useForm<EditCategoryForm>({
    resolver: zodResolver(EditCategoryFormSchema),
    defaultValues: { name: props.category.name },
  });

  const handleSubmit = form.handleSubmit((data) => {
    updateCategory.mutate(
      { id: props.category.id, name: data.name },
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
          disabled={updateCategory.isPending}
          onClick={props.onDone}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={updateCategory.isPending}>
          {updateCategory.isPending ? (
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
