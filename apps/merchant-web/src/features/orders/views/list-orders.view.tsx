import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ColumnDef, type Row } from "@tanstack/react-table";
import { format } from "date-fns";
import { TriangleAlertIcon } from "lucide-react";
import type { OrderListItem } from "merchant-sdk";
import { Alert, AlertDescription, AlertTitle } from "ui/alert";
import { Badge } from "ui/badge";
import { getListOrdersQueryOptions } from "../orders.hooks";
import { getFailedOrdersQueryOptions } from "../../failed-orders/failed-orders.hooks";
import { formatCents } from "../../../lib/currency";
import { DataTable } from "../../../components/data-table";
import { FulfillmentStatusBadge } from "../components/fulfillment-status-badge";
import { OrderStatusBadge } from "../components/order-status-badge";

const columns: ColumnDef<OrderListItem>[] = [
  {
    accessorKey: "id",
    header: "ID",
  },
  {
    accessorKey: "channel",
    header: "Channel",
    cell: ({ row }) => (
      <Badge variant="outline">
        {row.original.channel === "pos" ? "In-store" : "Online"}
      </Badge>
    ),
  },
  {
    accessorKey: "customerName",
    header: "Customer",
    cell: ({ row }) =>
      row.original.customerName || row.original.customerEmail ? (
        <div>
          <div>{row.original.customerName ?? "—"}</div>
          <div className="text-xs text-muted-foreground">
            {row.original.customerEmail}
          </div>
        </div>
      ) : (
        <span className="text-muted-foreground">Walk-in</span>
      ),
  },
  {
    accessorKey: "itemCount",
    header: "Items",
  },
  {
    accessorKey: "amountTotalCents",
    header: "Total",
    cell: ({ row }) => formatCents(row.original.amountTotalCents),
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => <OrderStatusBadge status={row.original.status} />,
  },
  {
    accessorKey: "fulfillmentStatus",
    header: "Fulfillment",
    cell: ({ row }) => <FulfillmentStatusBadge status={row.original.fulfillmentStatus} />,
  },
  {
    accessorKey: "createdAt",
    header: "Placed At",
    cell: ({ row }) => format(new Date(row.original.createdAt), "MM/dd/yyyy hh:mm a"),
  },
];

export function ListOrdersView() {
  const orders = useQuery(getListOrdersQueryOptions());
  const failedOrders = useQuery(getFailedOrdersQueryOptions());
  const unresolvedFailed = failedOrders.data?.unresolvedCount ?? 0;
  const navigate = useNavigate();

  const handleRowClick = (row: Row<OrderListItem>) => {
    navigate({ to: "/app/orders/$id", params: { id: row.original.id } });
  };

  return (
    <div className="space-y-4">
      {unresolvedFailed > 0 ? (
        <Link to="/app/failed-orders">
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>
              {unresolvedFailed} checkout{unresolvedFailed === 1 ? "" : "s"}{" "}
              failed and need attention
            </AlertTitle>
            <AlertDescription>
              View failed checkouts to review errors and retry.
            </AlertDescription>
          </Alert>
        </Link>
      ) : null}
      <DataTable
        onRowClick={handleRowClick}
        data={orders.data?.items ?? []}
        columns={columns}
        emptyMessage="No orders yet."
      />
    </div>
  );
}
