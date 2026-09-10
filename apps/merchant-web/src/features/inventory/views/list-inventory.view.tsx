import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useListInventoryQuery } from "../inventory.hooks";
import { DataTable } from "../../../components/data-table";
import { InputGroup, InputGroupAddon, InputGroupInput } from "ui/input-group";
import { HistoryIcon, SearchIcon } from "lucide-react";
import { type ColumnDef } from "@tanstack/react-table";
import type { InventoryRecord } from "merchant-sdk";
import { Field, FieldLabel } from "ui/field";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import { format } from "date-fns";
import { AdjustStockSheet } from "../components/adjust-stock-sheet";

const LOW_STOCK_THRESHOLD = 0;

export function ListInventoryView() {
  const inventory = useListInventoryQuery();
  const [adjustingRecord, setAdjustingRecord] = useState<InventoryRecord | null>(
    null,
  );

  const columns: ColumnDef<InventoryRecord>[] = [
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
      <div className="flex gap-4 items-end justify-between">
        <Field className="max-w-xs">
          <FieldLabel>Search</FieldLabel>
          <InputGroup>
            <InputGroupInput placeholder="Search inventory..." />
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
          </InputGroup>
        </Field>
        <Link to="/app/inventory/movements">
          <Button variant="outline">
            <HistoryIcon /> Movement history
          </Button>
        </Link>
      </div>
      <DataTable data={inventory.data?.items ?? []} columns={columns} />

      <AdjustStockSheet
        record={adjustingRecord}
        open={adjustingRecord !== null}
        onOpenChange={(open) => !open && setAdjustingRecord(null)}
      />
    </div>
  );
}
