import { useState } from "react";
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
import { useListUsersQuery } from "../users.hooks";
import { EditUserRolesSheet } from "./edit-user-roles-sheet";

const route = getRouteApi("/app/users/");

const columns: ColumnDef<User>[] = [
  {
    id: "name",
    header: "Name",
    cell: ({ row }) => `${row.original.firstName} ${row.original.lastName}`,
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
  const [editingUser, setEditingUser] = useState<User | null>(null);

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
        <Link to="/app/users/create">
          <Button>
            <PlusIcon /> Add user
          </Button>
        </Link>
      </div>
      <DataTable
        data={users.data?.items ?? []}
        columns={columns}
        onRowClick={(row) => setEditingUser(row.original)}
      />
      <DataTablePagination
        page={search.page}
        pageSize={PAGE_SIZE}
        total={users.data?.total ?? 0}
        onPageChange={(page) =>
          navigate({ search: (prev) => ({ ...prev, page }) })
        }
      />

      <EditUserRolesSheet
        user={editingUser}
        open={editingUser !== null}
        onOpenChange={(open) => !open && setEditingUser(null)}
      />
    </div>
  );
}
