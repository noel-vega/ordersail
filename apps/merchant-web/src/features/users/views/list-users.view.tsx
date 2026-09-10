import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getListUsersQueryOptions } from "../users.hooks";
import { DataTable } from "../../../components/data-table";
import { Button } from "ui/button";
import { Badge } from "ui/badge";
import { Link } from "@tanstack/react-router";
import { InputGroup, InputGroupAddon, InputGroupInput } from "ui/input-group";
import { PlusIcon, SearchIcon } from "lucide-react";
import { type ColumnDef } from "@tanstack/react-table";
import type { User } from "merchant-sdk";
import { Field, FieldLabel } from "ui/field";
import { format } from "date-fns";
import { EditUserRolesSheet } from "./edit-user-roles-sheet";

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
  const users = useQuery(getListUsersQueryOptions());
  const [editingUser, setEditingUser] = useState<User | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex gap-4 items-end justify-between">
        <Field className="max-w-xs">
          <FieldLabel>Search</FieldLabel>
          <InputGroup>
            <InputGroupInput placeholder="Search users..." />
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
          </InputGroup>
        </Field>
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

      <EditUserRolesSheet
        user={editingUser}
        open={editingUser !== null}
        onOpenChange={(open) => !open && setEditingUser(null)}
      />
    </div>
  );
}
