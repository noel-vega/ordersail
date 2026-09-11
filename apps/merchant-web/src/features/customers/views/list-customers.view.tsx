import { getRouteApi } from "@tanstack/react-router";
import { type ColumnDef } from "@tanstack/react-table";
import type { Customer } from "merchant-sdk";
import { format } from "date-fns";
import { DataTable } from "../../../components/data-table";
import { DataTablePagination } from "../../../components/data-table-pagination";
import { ListSearchInput } from "../../../components/list-search-input";
import { PAGE_SIZE } from "../../../lib/list-search";
import { useListCustomersQuery } from "../customers.hooks";

const route = getRouteApi("/app/customers/");

const columns: ColumnDef<Customer>[] = [
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

export function ListCustomersView() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const customers = useListCustomersQuery(search);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <ListSearchInput
          initialValue={search.q}
          placeholder="Search customers..."
          onDebouncedChange={(q) =>
            navigate({ search: (prev) => ({ ...prev, q, page: 1 }) })
          }
        />
      </div>
      <DataTable
        data={customers.data?.items ?? []}
        columns={columns}
        onRowClick={(row) =>
          navigate({ to: "/app/customers/$id", params: { id: row.original.id } })
        }
        emptyMessage={
          search.q ? undefined : "No customers yet — they'll appear here after their first order."
        }
      />
      <DataTablePagination
        page={search.page}
        pageSize={PAGE_SIZE}
        total={customers.data?.total ?? 0}
        onPageChange={(page) =>
          navigate({ search: (prev) => ({ ...prev, page }) })
        }
      />
    </div>
  );
}
