import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import type { InventoryRecord } from "merchant-sdk";
import { DataTable } from "../../../components/data-table";
import { Button } from "ui/button";
import { AdjustStockSheet } from "../../inventory/components/adjust-stock-sheet";
import { StockLevel } from "../../inventory/components/stock-level";
import { usePermissions } from "../../auth/permission-context";

function getColumns(lowStockThreshold: number): ColumnDef<InventoryRecord>[] {
  return [
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
      cell: ({ row }) => (
        <StockLevel stock={row.original.stock} threshold={lowStockThreshold} />
      ),
    },
  ];
}

export function ProductInventoryTab(props: {
  records: InventoryRecord[];
  lowStockThreshold: number;
}) {
  const [adjustingRecord, setAdjustingRecord] = useState<InventoryRecord | null>(
    null,
  );
  // the tab needs inventory:read; adjusting is inventory:write (OS-672)
  const canWriteInventory = usePermissions().has("inventory:write");

  const actionColumn: ColumnDef<InventoryRecord> = {
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
  };

  return (
    <div className="space-y-4">
      <DataTable
        columns={[
          ...getColumns(props.lowStockThreshold),
          ...(canWriteInventory ? [actionColumn] : []),
        ]}
        data={props.records}
      />

      <AdjustStockSheet
        record={adjustingRecord}
        open={adjustingRecord !== null}
        onOpenChange={(open) => !open && setAdjustingRecord(null)}
      />
    </div>
  );
}
