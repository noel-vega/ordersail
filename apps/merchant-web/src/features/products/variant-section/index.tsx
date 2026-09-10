import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "ui/sheet";
import { PlusCircleIcon } from "lucide-react";
import type { InventoryRecord, ProductOption, ProductVariant } from "merchant-sdk";
import { DataTable } from "../../../components/data-table";
import { useVariantOptions } from "./shared";
import { VariantOptionForm } from "./variant-option-form";
import { getVariantColumns } from "./variant-columns";
import { EditVariantSheet } from "./edit-variant-sheet";
import { useListLocationsQuery } from "../../locations/locations.hooks";
import { AdjustStockSheet } from "../../inventory/components/adjust-stock-sheet";

export function VariantSection({
  productId,
  productName,
}: {
  productId: number;
  productName: string;
}) {
  const { variants, productOptions, saveOption, removeOption, isSaving } =
    useVariantOptions(productId);
  // 'new' opens the drawer in create mode, an option id opens it for that option
  const [openTarget, setOpenTarget] = useState<number | "new" | null>(null);
  const [adjustingVariant, setAdjustingVariant] = useState<ProductVariant | null>(
    null,
  );
  const [editingVariant, setEditingVariant] = useState<ProductVariant | null>(null);

  const { data: locations } = useListLocationsQuery();
  // single-location for now — once there's more than one, adjusting stock
  // from here will need a location picker instead of a silent default
  const defaultLocation = locations?.items?.[0];

  const adjustingRecord: InventoryRecord | null =
    adjustingVariant && defaultLocation
      ? {
          id: adjustingVariant.id,
          variantId: adjustingVariant.id,
          sku: adjustingVariant.sku,
          productId,
          productName,
          locationId: defaultLocation.id,
          locationName: defaultLocation.name,
          stock: adjustingVariant.stock,
          updatedAt: adjustingVariant.updatedAt,
        }
      : null;

  const columns = getVariantColumns({
    onAdjustStock: (variant) => setAdjustingVariant(variant),
    onEdit: (variant) => setEditingVariant(variant),
  });

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {productOptions.map((option) => (
          <OptionChip
            key={option.id}
            option={option}
            onClick={() => setOpenTarget(option.id)}
          />
        ))}
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-full border border-dashed px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted"
          onClick={() => setOpenTarget("new")}
        >
          <PlusCircleIcon size={14} />
          Add option
        </button>
      </div>

      <DataTable columns={columns} data={variants} />

      <AdjustStockSheet
        record={adjustingRecord}
        open={adjustingVariant !== null}
        onOpenChange={(open) => !open && setAdjustingVariant(null)}
      />

      <EditVariantSheet
        productId={productId}
        variant={editingVariant}
        open={editingVariant !== null}
        onOpenChange={(open) => !open && setEditingVariant(null)}
      />

      <Sheet
        open={openTarget !== null}
        onOpenChange={(open) => !open && setOpenTarget(null)}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>
              {openTarget === "new" ? "Add option" : "Edit option"}
            </SheetTitle>
            <SheetDescription>
              Define the option name and its possible values.
            </SheetDescription>
          </SheetHeader>
          <div className="px-4">
            {openTarget !== null && (
              <SheetOptionForm
                productOptions={productOptions}
                target={openTarget}
                isSaving={isSaving}
                onSave={async (values) => {
                  await saveOption(openTarget, values);
                  setOpenTarget(null);
                }}
                onDelete={async () => {
                  await removeOption(openTarget);
                  setOpenTarget(null);
                }}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </section>
  );
}

function SheetOptionForm({
  productOptions,
  target,
  isSaving,
  onSave,
  onDelete,
}: {
  productOptions: ProductOption[];
  target: number | "new";
  isSaving: boolean;
  onSave: (values: { name: string; valuesText: string }) => void;
  onDelete: () => void;
}) {
  const existing =
    target !== "new"
      ? productOptions.find((option) => option.id === target)
      : undefined;

  return (
    <VariantOptionForm
      name={existing?.name ?? ""}
      valuesText={existing?.values.map((v) => v.value).join(", ") ?? ""}
      deleteLabel={target === "new" ? "Cancel" : "Delete"}
      isSaving={isSaving}
      onSave={onSave}
      onDelete={onDelete}
    />
  );
}

function OptionChip(props: { option: ProductOption; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm hover:bg-muted"
    >
      <span className="font-medium">{props.option.name || "Untitled option"}</span>
      <span className="text-muted-foreground">
        {props.option.values.map((v) => v.value).join(", ")}
      </span>
    </button>
  );
}
