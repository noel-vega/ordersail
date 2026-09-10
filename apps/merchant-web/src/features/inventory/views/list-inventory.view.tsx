import { useState } from "react";
import { Link, getRouteApi } from "@tanstack/react-router";
import { HistoryIcon } from "lucide-react";
import { type ColumnDef } from "@tanstack/react-table";
import type { InventoryRecord } from "merchant-sdk";
import { format } from "date-fns";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import { cn } from "ui/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "ui/select";
import { DataTable } from "../../../components/data-table";
import { DataTablePagination } from "../../../components/data-table-pagination";
import { ListSearchInput } from "../../../components/list-search-input";
import { PAGE_SIZE } from "../../../lib/list-search";
import { useListLocationsQuery } from "../../locations/locations.hooks";
import { useInventoryPageQuery } from "../inventory.hooks";
import { AdjustStockSheet } from "../components/adjust-stock-sheet";

const route = getRouteApi("/app/inventory/");
const LOW_STOCK_THRESHOLD = 0;
const ALL_LOCATIONS = "all";

export function ListInventoryView() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const inventory = useInventoryPageQuery(search);
  const locations = useListLocationsQuery();
  const [adjustingRecord, setAdjustingRecord] = useState<InventoryRecord | null>(
    null,
  );

  const columns: ColumnDef<InventoryRecord>[] = [
    { accessorKey: "productName", header: "Product" },
    {
      accessorKey: "sku",
      header: "SKU",
      cell: ({ row }) => row.original.sku ?? "—",
    },
    { accessorKey: "locationName", header: "Location" },
    {
      accessorKey: "stock",
      header: "Stock",
      cell: ({ row }) =>
        row.original.stock <= LOW_STOCK_THRESHOLD ? (
          <Badge variant="destructive">{row.original.stock}</Badge>
        ) : (
          row.original.stock
        ),
    },
    {
      accessorKey: "updatedAt",
      header: "Updated At",
      cell: ({ row }) =>
        format(new Date(row.original.updatedAt), "MM/dd/yyyy hh:mm a"),
    },
    {
      id: "actions",
      cell: ({ row }) => (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setAdjustingRecord(row.original)}
        >
          Adjust
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <ListSearchInput
            initialValue={search.q}
            placeholder="Search inventory..."
            onDebouncedChange={(q) =>
              navigate({ search: (prev) => ({ ...prev, q, page: 1 }) })
            }
          />
          <Select
            value={search.locationId ? String(search.locationId) : ALL_LOCATIONS}
            onValueChange={(value) =>
              navigate({
                search: (prev) => ({
                  ...prev,
                  locationId:
                    value === ALL_LOCATIONS ? undefined : Number(value),
                  page: 1,
                }),
              })
            }
          >
            <SelectTrigger className="w-44">
              <SelectValue placeholder="All locations" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_LOCATIONS}>All locations</SelectItem>
              {(locations.data?.items ?? []).map((loc) => (
                <SelectItem key={loc.id} value={String(loc.id)}>
                  {loc.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            className={cn(
              search.lowStock && "border-primary bg-primary/5 text-primary",
            )}
            onClick={() =>
              navigate({
                search: (prev) => ({
                  ...prev,
                  lowStock: prev.lowStock ? undefined : true,
                  page: 1,
                }),
              })
            }
          >
            Low stock
          </Button>
        </div>
        <Link to="/app/inventory/movements">
          <Button variant="outline">
            <HistoryIcon /> Movement history
          </Button>
        </Link>
      </div>

      <DataTable
        data={inventory.data?.items ?? []}
        columns={columns}
        emptyMessage={
          search.q || search.locationId || search.lowStock
            ? undefined
            : "No inventory yet — add a product with variants to start tracking stock."
        }
      />
      <DataTablePagination
        page={search.page}
        pageSize={PAGE_SIZE}
        total={inventory.data?.total ?? 0}
        onPageChange={(page) =>
          navigate({ search: (prev) => ({ ...prev, page }) })
        }
      />

      <AdjustStockSheet
        record={adjustingRecord}
        open={adjustingRecord !== null}
        onOpenChange={(open) => !open && setAdjustingRecord(null)}
      />
    </div>
  );
}
