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

// the variant row's stock action. Its label says where it leads: the Adjust
// stock sheet, or creating a location first (OS-689)
export type VariantStockAction = {
  label: string;
  run: (variant: ProductVariant) => void;
  // while the locations needed to decide are still loading
  disabled?: boolean;
};

export function getVariantColumns(options: {
  // omitted, the action isn't offered at all (e.g. no inventory:write, OS-672)
  adjustStock?: VariantStockAction;
  onEdit: (variant: ProductVariant) => void;
  lowStockThreshold: number;
  // set with more than one location: the stock shown is the total, and this
  // opens the per-location breakdown (OS-696)
  onViewStockByLocation?: () => void;
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
        (options.showEdit || options.adjustStock) && (
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
              {options.adjustStock && (
                <DropdownMenuItem
                  disabled={options.adjustStock.disabled}
                  onClick={() => options.adjustStock?.run(row.original)}
                >
                  <PackageIcon /> {options.adjustStock.label}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ),
    },
  ];
}
