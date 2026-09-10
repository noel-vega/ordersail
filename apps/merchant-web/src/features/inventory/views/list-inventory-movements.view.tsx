import { Link, getRouteApi } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { type ColumnDef } from "@tanstack/react-table";
import type { InventoryMovementRecord } from "merchant-sdk";
import { format } from "date-fns";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "ui/select";
import { DataTable } from "../../../components/data-table";
import { DataTablePagination } from "../../../components/data-table-pagination";
import { PAGE_SIZE } from "../../../lib/list-search";
import { MOVEMENT_REASONS, useMovementsPageQuery } from "../inventory.hooks";

const route = getRouteApi("/app/inventory/movements");
const ALL_REASONS = "all";

const columns: ColumnDef<InventoryMovementRecord>[] = [
  {
    accessorKey: "createdAt",
    header: "Date",
    cell: ({ row }) =>
      format(new Date(row.original.createdAt), "MM/dd/yyyy hh:mm a"),
  },
  { accessorKey: "productName", header: "Product" },
  {
    accessorKey: "sku",
    header: "SKU",
    cell: ({ row }) => row.original.sku ?? "—",
  },
  { accessorKey: "locationName", header: "Location" },
  {
    accessorKey: "delta",
    header: "Change",
    cell: ({ row }) => (
      <Badge variant={row.original.delta > 0 ? "secondary" : "destructive"}>
        {row.original.delta > 0 ? "+" : ""}
        {row.original.delta}
      </Badge>
    ),
  },
  { accessorKey: "reason", header: "Reason" },
  {
    accessorKey: "note",
    header: "Note",
    cell: ({ row }) => row.original.note ?? "—",
  },
  {
    accessorKey: "createdByEmail",
    header: "By",
    cell: ({ row }) => row.original.createdByEmail ?? "—",
  },
];

export function ListInventoryMovementsView() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const movements = useMovementsPageQuery(search);

  return (
    <div className="space-y-4">
      <Link to="/app/inventory">
        <Button variant="ghost" size="sm">
          <ArrowLeftIcon /> Back to inventory
        </Button>
      </Link>

      <Select
        value={search.reason ?? ALL_REASONS}
        onValueChange={(value) =>
          navigate({
            search: (prev) => ({
              ...prev,
              reason:
                value === ALL_REASONS
                  ? undefined
                  : (value as InventoryMovementRecord["reason"]),
              page: 1,
            }),
          })
        }
      >
        <SelectTrigger className="w-44 capitalize">
          <SelectValue placeholder="All reasons" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_REASONS}>All reasons</SelectItem>
          {MOVEMENT_REASONS.map((reason) => (
            <SelectItem key={reason} value={reason} className="capitalize">
              {reason}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <DataTable data={movements.data?.items ?? []} columns={columns} />
      <DataTablePagination
        page={search.page}
        pageSize={PAGE_SIZE}
        total={movements.data?.total ?? 0}
        onPageChange={(page) =>
          navigate({ search: (prev) => ({ ...prev, page }) })
        }
      />
    </div>
  );
}
