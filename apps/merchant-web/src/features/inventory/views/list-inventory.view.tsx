import { useState } from "react";
import { Link, getRouteApi } from "@tanstack/react-router";
import { HistoryIcon } from "lucide-react";
import { type ColumnDef, type Row } from "@tanstack/react-table";
import type { InventoryRecord, VariantStockRecord } from "merchant-sdk";
import { format } from "date-fns";
import { Button } from "ui/button";
import { cn } from "ui/utils";
import { Tabs, TabsList, TabsTrigger } from "ui/tabs";
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
import { useStockLocations } from "../../locations/locations.hooks";
import {
  useInventoryPageQuery,
  useVariantStockPageQuery,
} from "../inventory.hooks";
import { AdjustStockSheet } from "../components/adjust-stock-sheet";
import {
  type AdjustStockTarget,
  targetFromInventoryRecord,
  targetFromVariantStockRecord,
} from "../components/adjust-stock-target";
import { StockLevel } from "../components/stock-level";
import { usePermissions } from "../../auth/permission-context";

const route = getRouteApi("/app/inventory/");
const ALL_LOCATIONS = "all";
const BY_LOCATION = "location";
const BY_VARIANT = "variant";

export function ListInventoryView() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  // By variant sums each variant's stock across locations, and judges
  // low/out on that total — exactly as the dashboard does (OS-693)
  const byVariant = search.view === "variant";
  const inventory = useInventoryPageQuery(search, !byVariant);
  const variants = useVariantStockPageQuery(search, byVariant);
  const stockLocations = useStockLocations();
  const canAdjust = usePermissions().has("inventory:write");
  const page = byVariant ? variants.data : inventory.data;
  // from the same response the lowStock filter ran on, so the Low badges and
  // the filter always agree (OS-668)
  const lowStockThreshold = page?.lowStockThreshold ?? 0;
  const [adjusting, setAdjusting] = useState<AdjustStockTarget | null>(null);

  function adjustColumn<T>(toTarget: (row: T) => AdjustStockTarget) {
    return {
      id: "actions",
      cell: ({ row }: { row: Row<T> }) => (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setAdjusting(toTarget(row.original))}
        >
          Adjust
        </Button>
      ),
    };
  }

  const rowColumns: ColumnDef<InventoryRecord>[] = [
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
      cell: ({ row }) => (
        <StockLevel stock={row.original.stock} threshold={lowStockThreshold} />
      ),
    },
    {
      accessorKey: "updatedAt",
      header: "Updated At",
      cell: ({ row }) =>
        format(new Date(row.original.updatedAt), "MM/dd/yyyy hh:mm a"),
    },
    ...(canAdjust ? [adjustColumn(targetFromInventoryRecord)] : []),
  ];

  const variantColumns: ColumnDef<VariantStockRecord>[] = [
    {
      accessorKey: "productName",
      header: "Product",
      cell: ({ row }) => (
        <>
          {row.original.productName}
          {row.original.optionsLabel && (
            <span className="text-muted-foreground">
              {" "}
              · {row.original.optionsLabel}
            </span>
          )}
        </>
      ),
    },
    {
      accessorKey: "sku",
      header: "SKU",
      cell: ({ row }) => row.original.sku ?? "—",
    },
    {
      id: "locations",
      header: "By location",
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.locations.length === 0
            ? "—"
            : row.original.locations
                .map((l) => `${l.locationName} ${l.stock}`)
                .join(" · ")}
        </span>
      ),
    },
    {
      accessorKey: "stock",
      header: "Total",
      cell: ({ row }) => (
        <StockLevel stock={row.original.stock} threshold={lowStockThreshold} />
      ),
    },
    // the sheet offers every location, so it needs them loaded and at least
    // one to put stock at
    ...(canAdjust && stockLocations.isLoaded && !stockLocations.noLocation
      ? [
          adjustColumn((record: VariantStockRecord) =>
            targetFromVariantStockRecord(record, stockLocations.locations),
          ),
        ]
      : []),
  ];

  const filtered = Boolean(search.q || search.lowStock);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <Tabs
            value={byVariant ? BY_VARIANT : BY_LOCATION}
            onValueChange={(value) =>
              navigate({
                search: (prev) => ({
                  ...prev,
                  view: value === BY_VARIANT ? "variant" : undefined,
                  // a variant's total spans every location
                  locationId: undefined,
                  page: 1,
                }),
              })
            }
          >
            <TabsList>
              <TabsTrigger value={BY_LOCATION}>By location</TabsTrigger>
              <TabsTrigger value={BY_VARIANT}>By variant</TabsTrigger>
            </TabsList>
          </Tabs>
          <ListSearchInput
            initialValue={search.q}
            placeholder="Search inventory..."
            onDebouncedChange={(q) =>
              navigate({ search: (prev) => ({ ...prev, q, page: 1 }) })
            }
          />
          {!byVariant && (
            <Select
              value={
                search.locationId ? String(search.locationId) : ALL_LOCATIONS
              }
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
                {stockLocations.locations.map((loc) => (
                  <SelectItem key={loc.id} value={String(loc.id)}>
                    {loc.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
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

      {byVariant ? (
        <DataTable
          data={variants.data?.items ?? []}
          columns={variantColumns}
          emptyMessage={
            filtered
              ? undefined
              : "No variants yet — add a product to start tracking stock."
          }
        />
      ) : (
        <DataTable
          data={inventory.data?.items ?? []}
          columns={rowColumns}
          emptyMessage={
            filtered || search.locationId
              ? undefined
              : "No inventory yet — add a product with variants to start tracking stock."
          }
        />
      )}
      <DataTablePagination
        page={search.page}
        pageSize={PAGE_SIZE}
        total={page?.total ?? 0}
        onPageChange={(next) =>
          navigate({ search: (prev) => ({ ...prev, page: next }) })
        }
      />

      <AdjustStockSheet
        target={adjusting}
        open={adjusting !== null}
        onOpenChange={(open) => !open && setAdjusting(null)}
      />
    </div>
  );
}
