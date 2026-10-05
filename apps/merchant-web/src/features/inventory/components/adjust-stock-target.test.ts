import { describe, expect, it } from "vitest"
import type { VariantStockRecord } from "merchant-sdk"
import { targetFromVariantStockRecord } from "./adjust-stock-target"

const record: VariantStockRecord = {
  variantId: 7,
  productId: 3,
  productName: "Shirt",
  sku: "SH-L",
  optionsLabel: "Large",
  stock: 9,
  locations: [{ locationId: 1, locationName: "Warehouse", stock: 9 }],
}

describe("targetFromVariantStockRecord (OS-693)", () => {
  it("offers every location, with 0 where the variant has no inventory row", () => {
    expect(
      targetFromVariantStockRecord(record, [
        { id: 1, name: "Warehouse" },
        { id: 2, name: "Storefront" },
      ]),
    ).toEqual({
      variantId: 7,
      productName: "Shirt · Large",
      sku: "SH-L",
      locations: [
        { id: 1, name: "Warehouse", stock: 9 },
        { id: 2, name: "Storefront", stock: 0 },
      ],
    })
  })

  it("names a variant without options by its product alone", () => {
    const target = targetFromVariantStockRecord(
      { ...record, optionsLabel: null },
      [{ id: 1, name: "Warehouse" }],
    )
    expect(target.productName).toBe("Shirt")
  })
})
