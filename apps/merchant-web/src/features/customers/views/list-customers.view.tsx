import { useQuery } from "@tanstack/react-query";
import { getListCustomersQueryOptions } from "../customers.hooks";
import { DataTable } from "../../../components/data-table";
import { InputGroup, InputGroupAddon, InputGroupInput } from "ui/input-group";
import { SearchIcon } from "lucide-react";
import { type ColumnDef } from "@tanstack/react-table";
import type { Customer } from "merchant-sdk";
import { Field, FieldLabel } from "ui/field";
import { format } from "date-fns";

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
  const customers = useQuery(getListCustomersQueryOptions());

  return (
    <div className="space-y-4">
      <div className="flex gap-4 items-end justify-between">
        <Field className="max-w-xs">
          <FieldLabel>Search</FieldLabel>
          <InputGroup>
            <InputGroupInput placeholder="Search customers..." />
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
          </InputGroup>
        </Field>
      </div>
      <DataTable data={customers.data?.items ?? []} columns={columns} />
    </div>
  );
}
