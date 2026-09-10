import { Link, getRouteApi } from "@tanstack/react-router";
import { Button } from "ui/button";
import { Badge } from "ui/badge";
import { PlusIcon } from "lucide-react";
import { type ColumnDef } from "@tanstack/react-table";
import type { User } from "merchant-sdk";
import { format } from "date-fns";
import { DataTable } from "../../../components/data-table";
import { DataTablePagination } from "../../../components/data-table-pagination";
import { ListSearchInput } from "../../../components/list-search-input";
import { PAGE_SIZE } from "../../../lib/list-search";
import { Can } from "../../../components/can";
import { useListUsersQuery } from "../users.hooks";
import { UserStatusBadge } from "./user-status-badge";

const route = getRouteApi("/app/users/");

const columns: ColumnDef<User>[] = [
  {
    id: "name",
    header: "Name",
    cell: ({ row }) => `${row.original.firstName} ${row.original.lastName}`,
  },
  {
    id: "status",
    header: "Status",
    cell: ({ row }) => <UserStatusBadge status={row.original.status} />,
  },
  {
    accessorKey: "phone",
    header: "Phone",
    cell: ({ row }) => row.original.phone ?? "—",
  },
  {
    accessorKey: "email",
    header: "Email",
  },
  {
    id: "roles",
    header: "Roles",
    cell: ({ row }) =>
      row.original.roles.length > 0 ? (
        <span className="flex flex-wrap gap-1">
          {row.original.roles.map((role) => (
            <Badge key={role.id} variant="outline">
              {role.name}
            </Badge>
          ))}
        </span>
      ) : (
        <span className="text-muted-foreground">No roles</span>
      ),
  },
  {
    accessorKey: "createdAt",
    header: "Added",
    cell: ({ row }) =>
      format(new Date(row.original.createdAt), "MM/dd/yyyy hh:mm a"),
  },
];

export function ListUsersView() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const users = useListUsersQuery(search);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <ListSearchInput
          initialValue={search.q}
          placeholder="Search users..."
          onDebouncedChange={(q) =>
            navigate({ search: (prev) => ({ ...prev, q, page: 1 }) })
          }
        />
        <Can permission="users:write">
          <Link to="/app/users/create">
            <Button>
              <PlusIcon /> Add user
            </Button>
          </Link>
        </Can>
      </div>
      <DataTable
        data={users.data?.items ?? []}
        columns={columns}
        onRowClick={(row) =>
          navigate({ to: "/app/users/$id", params: { id: row.original.id } })
        }
        emptyMessage={search.q ? undefined : "No team members yet."}
      />
      <DataTablePagination
        page={search.page}
        pageSize={PAGE_SIZE}
        total={users.data?.total ?? 0}
        onPageChange={(page) =>
          navigate({ search: (prev) => ({ ...prev, page }) })
        }
      />
    </div>
  );
}
