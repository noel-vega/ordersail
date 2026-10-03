import type { InventoryRecord } from "merchant-sdk";

export type AdjustStockLocation = {
  id: number;
  name: string;
  // this variant's stock there; null when it can't be read (no inventory:read)
  stock: number | null;
};

// what's being adjusted: one variant, at one fixed location or — with more
// than one to choose from — wherever the merchant picks
export type AdjustStockTarget = {
  variantId: number;
  productName: string;
  sku: string | null;
  locations: AdjustStockLocation[];
};

// an inventory row already names its location
export function recordTarget(record: InventoryRecord): AdjustStockTarget {
  return {
    variantId: record.variantId,
    productName: record.productName,
    sku: record.sku,
    locations: [
      { id: record.locationId, name: record.locationName, stock: record.stock },
    ],
  };
}
