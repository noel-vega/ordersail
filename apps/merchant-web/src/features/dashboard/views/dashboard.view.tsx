import { useQuery } from "@tanstack/react-query";
import {
  getDashboardSalesQueryOptions,
  getDashboardSalesTimeseriesQueryOptions,
  getDashboardSummaryQueryOptions,
} from "../dashboard.hooks";
import { formatRangeLabel, toApiRange } from "../dashboard-range";
import { DateRangePicker } from "../components/date-range-picker";
import { MetricCard } from "../components/metric-card";
import { SalesTrendChart } from "../components/sales-trend-chart";
import { OrdersTrendChart } from "../components/orders-trend-chart";
import { getFailedOrdersQueryOptions } from "../../failed-orders/failed-orders.hooks";
import { DataTable } from "../../../components/data-table";
import { cn } from "ui/utils";
import { type ColumnDef } from "@tanstack/react-table";
import type { OrderListItem, Customer } from "merchant-sdk";
import { Link, getRouteApi } from "@tanstack/react-router";
import { format } from "date-fns";
import { formatCents } from "../../../lib/currency";

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

const route = getRouteApi("/app/dashboard/");

export function DashboardView() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const { params, preset } = toApiRange(search);

  const dashboard = useQuery(getDashboardSummaryQueryOptions());
  const summary = dashboard.data;
  const salesQuery = useQuery(getDashboardSalesQueryOptions(params));
  const sales = salesQuery.data;
  const timeseriesQuery = useQuery(
    getDashboardSalesTimeseriesQueryOptions(params),
  );
  const failedOrders = useQuery(getFailedOrdersQueryOptions());
  const unresolvedFailed = failedOrders.data?.unresolvedCount ?? 0;

  const previousLabel = sales
    ? formatRangeLabel(sales.range.previousFrom, sales.range.previousTo)
    : "previous period";
  const comparison = (pick: (t: NonNullable<typeof sales>["current"]) => number) =>
    sales
      ? { current: pick(sales.current), previous: pick(sales.previous), previousLabel }
      : undefined;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <DateRangePicker
          preset={preset}
          from={sales?.range.from}
          to={sales?.range.to}
          today={sales?.range.today}
          onPresetChange={(range) => navigate({ search: { range } })}
          onCustomChange={({ from, to }) => navigate({ search: { from, to } })}
        />
        {sales && (
          <p className="text-xs text-muted-foreground">
            Days in {sales.range.timezone.replaceAll("_", " ")}
          </p>
        )}
      </div>

      {/* dimmed while a new range loads over the previous one */}
      <section
        aria-label="Sales for the selected range"
        aria-busy={salesQuery.isPlaceholderData}
        className={cn(
          "grid grid-cols-1 gap-4 transition-opacity sm:grid-cols-3",
          salesQuery.isPlaceholderData && "opacity-60",
        )}
      >
        <MetricCard
          title="Net sales"
          value={formatCents(sales?.current.netSalesCents ?? 0)}
          comparison={comparison((t) => t.netSalesCents)}
          detail={
            sales &&
            `Gross ${formatCents(sales.current.grossSalesCents)} · Refunds ${formatCents(sales.current.refundsCents)}`
          }
        />
        <MetricCard
          title="Orders"
          value={sales?.current.orderCount ?? 0}
          comparison={comparison((t) => t.orderCount)}
        />
        <MetricCard
          title="Avg. order value"
          value={formatCents(sales?.current.averageOrderValueCents ?? 0)}
          comparison={comparison((t) => t.averageOrderValueCents)}
        />
      </section>

      <section
        aria-label="Sales and orders over the selected range"
        aria-busy={timeseriesQuery.isPlaceholderData}
        className={cn(
          "grid grid-cols-1 gap-4 transition-opacity lg:grid-cols-2",
          timeseriesQuery.isPlaceholderData && "opacity-60",
        )}
      >
        <SalesTrendChart query={timeseriesQuery} />
        <OrdersTrendChart query={timeseriesQuery} />
      </section>

      {/* point-in-time — not affected by the range above */}
      <section aria-labelledby="dashboard-now" className="space-y-2">
        <h2
          id="dashboard-now"
          className="text-sm font-medium text-muted-foreground"
        >
          Right now
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <MetricCard
            title="Out of stock"
            value={summary?.outOfStockCount ?? 0}
          />
          <Link to="/app/failed-orders" className="flex">
            <MetricCard
              title="Failed orders"
              value={unresolvedFailed}
              tone={unresolvedFailed > 0 ? "alert" : "default"}
              interactive
            />
          </Link>
        </div>
      </section>

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
