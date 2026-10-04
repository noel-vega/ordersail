import type { InventoryRecord } from "merchant-sdk";
import type { StockLocationOption } from "../../locations/components/stock-location-select";

// what's being adjusted: one variant, at one fixed location or — with more
// than one to choose from — wherever the merchant picks. Each location's
// `stock` is this variant's stock there, null when it can't be told
export type AdjustStockTarget = {
  variantId: number;
  productName: string;
  sku: string | null;
  locations: StockLocationOption[];
};

// the location a target is pinned to, when there's only one to choose.
// Counting `locations` is right here, unlike the account-wide "one or several
// locations?" question, which comes from the list's `total` (OS-696). This
// asks how many choices this sheet offers. A target from an inventory row has
// exactly one by design. The variant section passes the capped picker list,
// whose length is 1 exactly when `total` is.
export function fixedLocation(
  target: AdjustStockTarget,
): StockLocationOption | undefined {
  return target.locations.length === 1 ? target.locations[0] : undefined;
}

// an inventory row already names its location
export function targetFromInventoryRecord(
  record: InventoryRecord,
): AdjustStockTarget {
  return {
    variantId: record.variantId,
    productName: record.productName,
    sku: record.sku,
    locations: [
      { id: record.locationId, name: record.locationName, stock: record.stock },
    ],
  };
}
