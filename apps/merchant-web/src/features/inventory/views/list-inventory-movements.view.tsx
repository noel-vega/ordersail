import { Link } from "@tanstack/react-router";
import { useListInventoryMovementsQuery } from "../inventory.hooks";
import { DataTable } from "../../../components/data-table";
import { Button } from "ui/button";
import { ArrowLeftIcon } from "lucide-react";
import { type ColumnDef } from "@tanstack/react-table";
import type { InventoryMovementRecord } from "merchant-sdk";
import { Badge } from "ui/badge";
import { format } from "date-fns";

const columns: ColumnDef<InventoryMovementRecord>[] = [
  {
    accessorKey: "createdAt",
    header: "Date",
    cell: ({ row }) =>
      format(new Date(row.original.createdAt), "MM/dd/yyyy hh:mm a"),
  },
  {
    accessorKey: "productName",
    header: "Product",
  },
  {
    accessorKey: "sku",
    header: "SKU",
    cell: ({ row }) => row.original.sku ?? "—",
  },
  {
    accessorKey: "locationName",
    header: "Location",
  },
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
  {
    accessorKey: "reason",
    header: "Reason",
  },
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
  const movements = useListInventoryMovementsQuery();

  return (
    <div className="space-y-4">
      <Link to="/app/inventory">
        <Button variant="ghost" size="sm">
          <ArrowLeftIcon /> Back to inventory
        </Button>
      </Link>
      <DataTable data={movements.data?.items ?? []} columns={columns} />
    </div>
  );
}
