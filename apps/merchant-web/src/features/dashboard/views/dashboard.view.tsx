import { useQuery } from "@tanstack/react-query";
import { getDashboardSummaryQueryOptions } from "../dashboard.hooks";
import { getFailedOrdersQueryOptions } from "../../failed-orders/failed-orders.hooks";
import { DataTable } from "../../../components/data-table";
import { Card, CardHeader, CardTitle, CardContent } from "ui/card";
import { cn } from "ui/utils";
import { type ColumnDef } from "@tanstack/react-table";
import type { OrderListItem, Customer } from "merchant-sdk";
import { Link } from "@tanstack/react-router";
import { format } from "date-fns";
import { formatCents } from "../../../lib/currency";

function MetricCard(props: {
  title: string;
  value: string | number;
  tone?: "default" | "alert";
  interactive?: boolean;
}) {
  return (
    <Card
      className={cn(
        "flex-1",
        props.interactive && "transition-colors hover:bg-accent",
        props.tone === "alert" && "border-destructive",
      )}
    >
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
      </CardHeader>
      <CardContent
        className={cn(
          "text-2xl font-semibold",
          props.tone === "alert" && "text-destructive",
        )}
      >
        {props.value}
      </CardContent>
    </Card>
  );
}

const orderColumns: ColumnDef<OrderListItem>[] = [
  {
    id: "customer",
    header: "Customer",
    cell: ({ row }) => (
      <Link
        to="/app/orders/$id"
        params={{ id: row.original.id }}
        className="hover:underline"
      >
        {row.original.customerName}
      </Link>
    ),
  },
  {
    accessorKey: "amountTotalCents",
    header: "Total",
    cell: ({ row }) => formatCents(row.original.amountTotalCents),
  },
  {
    accessorKey: "createdAt",
    header: "Placed",
    cell: ({ row }) =>
      format(new Date(row.original.createdAt), "MM/dd/yyyy hh:mm a"),
  },
];

const customerColumns: ColumnDef<Customer>[] = [
  {
    id: "name",
    header: "Name",
    cell: ({ row }) => `${row.original.firstName} ${row.original.lastName}`,
  },
  {
    accessorKey: "email",
    header: "Email",
  },
  {
    accessorKey: "createdAt",
    header: "Joined",
    cell: ({ row }) =>
      format(new Date(row.original.createdAt), "MM/dd/yyyy hh:mm a"),
  },
];

export function DashboardView() {
  const dashboard = useQuery(getDashboardSummaryQueryOptions());
  const summary = dashboard.data;
  const failedOrders = useQuery(getFailedOrdersQueryOptions());
  const unresolvedFailed = failedOrders.data?.unresolvedCount ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex gap-4">
        <MetricCard title="Orders" value={summary?.orderCount ?? 0} />
        <MetricCard
          title="Revenue"
          value={formatCents(summary?.revenueCents ?? 0)}
        />
        <MetricCard
          title="Out of Stock"
          value={summary?.outOfStockCount ?? 0}
        />
        <Link to="/app/failed-orders" className="flex-1">
          <MetricCard
            title="Failed Orders"
            value={unresolvedFailed}
            tone={unresolvedFailed > 0 ? "alert" : "default"}
            interactive
          />
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            Recent Orders
          </h2>
          <DataTable
            data={summary?.recentOrders ?? []}
            columns={orderColumns}
          />
        </div>
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            Recent Customers
          </h2>
          <DataTable
            data={summary?.recentCustomers ?? []}
            columns={customerColumns}
          />
        </div>
      </div>
    </div>
  );
}
