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
  // what the action says — it may lead to creating a location (OS-689) or to
  // the Inventory tab instead of opening the sheet
  adjustStockLabel: string;
  onEdit: (variant: ProductVariant) => void;
  lowStockThreshold: number;
  // set with more than one location: the stock shown is the total, and this
  // opens the per-location breakdown (OS-696)
  onViewStockByLocation?: () => void;
  // inventory:write — without it the action isn't offered at all (OS-672)
  showAdjustStock: boolean;
  // products:write — the edit is refused server-side without it (OS-672)
  showEdit: boolean;
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
        <div className="flex items-center gap-2">
          <StockLevel
            stock={row.original.stock}
            threshold={options.lowStockThreshold}
          />
          {options.onViewStockByLocation && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto px-0"
              onClick={options.onViewStockByLocation}
            >
              By location
            </Button>
          )}
        </div>
      ),
    },
    {
      id: "actions",
      // a role with neither action gets no menu at all, not an empty one
      cell: ({ row }) =>
        (options.showEdit || options.showAdjustStock) && (
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
              {options.showEdit && (
                <DropdownMenuItem onClick={() => options.onEdit(row.original)}>
                  <PencilIcon /> Edit variant
                </DropdownMenuItem>
              )}
              {options.showAdjustStock && (
                <DropdownMenuItem onClick={() => options.onAdjustStock(row.original)}>
                  <PackageIcon /> {options.adjustStockLabel}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ),
    },
  ];
}
