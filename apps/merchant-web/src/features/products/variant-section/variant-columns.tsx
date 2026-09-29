import type { ColumnDef } from "@tanstack/react-table";
import type { ProductVariant } from "merchant-sdk";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
import { MoreVerticalIcon, PackageIcon, PencilIcon } from "lucide-react";
import { formatCents } from "../../../lib/currency";
import { StockLevel } from "../../inventory/components/stock-level";

export function getVariantColumns(options: {
  onAdjustStock: (variant: ProductVariant) => void;
  onEdit: (variant: ProductVariant) => void;
  lowStockThreshold: number;
  // false while the account has no location to hold stock (OS-689) — the
  // action then leads to creating one instead
  canAdjustStock: boolean;
  // inventory:write — without it the action isn't offered at all (OS-672)
  showAdjustStock: boolean;
}): ColumnDef<ProductVariant>[] {
  return [
    {
      id: "options",
      header: "Variant",
      cell: ({ row }) =>
        row.original.optionValues.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {row.original.optionValues.map((ov) => (
              <Badge key={`${ov.optionName}:${ov.value}`} variant="outline">
                {ov.optionName}: {ov.value}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground">Default</span>
        ),
    },
    {
      accessorKey: "sku",
      header: "SKU",
      cell: ({ row }) => row.original.sku ?? "—",
    },
    {
      accessorKey: "priceCents",
      header: "Price",
      cell: ({ row }) => formatCents(row.original.priceCents),
    },
    {
      accessorKey: "stock",
      header: "Stock",
      cell: ({ row }) => (
        <StockLevel
          stock={row.original.stock}
          threshold={options.lowStockThreshold}
        />
      ),
    },
    {
      id: "actions",
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Variant actions"
              />
            }
          >
            <MoreVerticalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => options.onEdit(row.original)}>
              <PencilIcon /> Edit variant
            </DropdownMenuItem>
            {options.showAdjustStock && (
              <DropdownMenuItem onClick={() => options.onAdjustStock(row.original)}>
                <PackageIcon />{" "}
                {options.canAdjustStock
                  ? "Adjust stock"
                  : "Add a location to adjust stock"}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];
}
