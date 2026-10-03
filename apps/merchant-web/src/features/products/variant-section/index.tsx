import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "ui/sheet";
import { PlusCircleIcon } from "lucide-react";
import type { ProductOption, ProductVariant } from "merchant-sdk";
import { DataTable } from "../../../components/data-table";
import { useVariantOptions } from "./shared";
import { VariantOptionForm } from "./variant-option-form";
import { getVariantColumns, type VariantStockAction } from "./variant-columns";
import { EditVariantSheet } from "./edit-variant-sheet";
import { useStockLocations } from "../../locations/locations.hooks";
import { AdjustStockSheet } from "../../inventory/components/adjust-stock-sheet";
import type { AdjustStockTarget } from "../../inventory/components/adjust-stock-target";
import { useProductInventoryQuery } from "../../inventory/inventory.hooks";
import { usePermissions } from "../../auth/permission-context";

export function VariantSection({
  productId,
  productName,
  onViewStockByLocation,
}: {
  productId: number;
  productName: string;
  // opens the product's Inventory tab, which lists stock per location
  onViewStockByLocation: () => void;
}) {
  const { variants, productOptions, saveOption, removeOption, isSaving } =
    useVariantOptions(productId);
  // 'new' opens the drawer in create mode, an option id opens it for that option
  const [openTarget, setOpenTarget] = useState<number | "new" | null>(null);
  const [adjustingVariant, setAdjustingVariant] = useState<ProductVariant | null>(
    null,
  );
  const [editingVariant, setEditingVariant] = useState<ProductVariant | null>(null);

  const navigate = useNavigate();
  const stockLocations = useStockLocations();

  // shares ProductView's cached query; the threshold rides on the inventory
  // response so staff without account:read still get Low badges (OS-668)
  const { data: inventory } = useProductInventoryQuery(productId);
  // 0 without inventory:read (no threshold to read, OS-672): only out-of-stock
  // is flagged, never a guessed "low"
  const lowStockThreshold = inventory?.lowStockThreshold ?? 0;
  const permissions = usePermissions();
  const canReadInventory = permissions.has("inventory:read");
  const canWriteInventory = permissions.has("inventory:write");
  const canWriteProducts = permissions.has("products:write");
  const { multiLocation } = stockLocations;

  // a variant's stock at each location it could be adjusted at. With one
  // location that's simply its total; with several it's read off the
  // product's inventory rows — 0 where a row is missing, unless the rows were
  // cut off by the page cap (or can't be read) and missing means unknown
  const stockAt = (variant: ProductVariant, locationId: number) => {
    if (!inventory) return null;
    const row = inventory.items.find(
      (r) => r.variantId === variant.id && r.locationId === locationId,
    );
    if (row) return row.stock;
    return inventory.total <= inventory.items.length ? 0 : null;
  };

  const adjustingTarget: AdjustStockTarget | null = adjustingVariant && {
    variantId: adjustingVariant.id,
    productName,
    sku: adjustingVariant.sku,
    // with more than one location the merchant picks — none is preselected
    // (OS-696)
    locations: stockLocations.locations.map((l) => ({
      id: l.id,
      name: l.name,
      stock: multiLocation
        ? stockAt(adjustingVariant, l.id)
        : adjustingVariant.stock,
    })),
  };

  const columns = getVariantColumns({
    adjustStock: canWriteInventory
      ? variantStockAction({
          stockLocations,
          openSheet: setAdjustingVariant,
          createLocation: () => navigate({ to: "/app/locations/create" }),
        })
      : undefined,
    onEdit: (variant) => setEditingVariant(variant),
    lowStockThreshold,
    // the row's number is the total across locations; the breakdown lives on
    // the Inventory tab
    onViewStockByLocation:
      multiLocation && canReadInventory ? onViewStockByLocation : undefined,
    showEdit: canWriteProducts,
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
        target={adjustingTarget}
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

// where a variant row's stock action leads. It never guesses a location: with
// several, the sheet asks (OS-696)
function variantStockAction(deps: {
  stockLocations: ReturnType<typeof useStockLocations>;
  openSheet: (variant: ProductVariant) => void;
  createLocation: () => void;
}): VariantStockAction {
  const { stockLocations } = deps;
  if (!stockLocations.isLoaded) {
    return { label: "Adjust stock", run: () => {}, disabled: true };
  }
  if (stockLocations.noLocation) {
    // an account has no location until the merchant creates one (OS-689);
    // stock needs somewhere to live, so send them there first
    return { label: "Add a location to adjust stock", run: deps.createLocation };
  }
  return { label: "Adjust stock", run: deps.openSheet };
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
