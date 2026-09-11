import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { type ColumnDef } from "@tanstack/react-table";
import type { CustomerOrderSummary } from "merchant-sdk";
import { format } from "date-fns";
import { Button } from "ui/button";
import { Badge } from "ui/badge";
import { DataTable } from "../../../components/data-table";
import { DataTablePagination } from "../../../components/data-table-pagination";
import { PAGE_SIZE } from "../../../lib/list-search";
import { formatCents } from "../../../lib/currency";
import { OrderStatusBadge } from "../../orders/components/order-status-badge";
import { useCustomerOrdersQuery, useCustomerSuspenseQuery } from "../customers.hooks";

const columns: ColumnDef<CustomerOrderSummary>[] = [
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
    accessorKey: "createdAt",
    header: "Date",
    cell: ({ row }) =>
      format(new Date(row.original.createdAt), "MM/dd/yyyy hh:mm a"),
  },
];

export function CustomerDetailView({ id }: { id: number }) {
  const navigate = useNavigate();
  const { data: customer } = useCustomerSuspenseQuery(id);
  const [page, setPage] = useState(1);
  const orders = useCustomerOrdersQuery(id, page);

  return (
    <div>
      <header className="mb-8 flex items-start gap-3">
        <Link to="/app/customers">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Back to customers"
          >
            <ArrowLeftIcon />
          </Button>
        </Link>
        <div>
          <h1 className="text-lg font-semibold">
            {customer.firstName} {customer.lastName}
          </h1>
          <p className="text-sm text-muted-foreground">{customer.email}</p>
        </div>
      </header>

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-medium">Lifetime value</h2>
        <p className="text-2xl font-semibold">
          {formatCents(customer.lifetimeValueCents)}
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">Orders</h2>
        <DataTable
          data={orders.data?.items ?? []}
          columns={columns}
          onRowClick={(row) =>
            navigate({ to: "/app/orders/$id", params: { id: row.original.id } })
          }
          emptyMessage="No orders yet."
        />
        <DataTablePagination
          page={page}
          pageSize={PAGE_SIZE}
          total={orders.data?.total ?? 0}
          onPageChange={setPage}
        />
      </section>
    </div>
  );
}
