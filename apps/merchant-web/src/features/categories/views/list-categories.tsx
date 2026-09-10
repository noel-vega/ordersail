
import { useQuery } from "@tanstack/react-query";
import { getListCategoriesQueryOptions } from "../categories.hooks";
import { DataTable } from "../../../components/data-table";
import { Button } from "ui/button";
import { Link } from "@tanstack/react-router";
import { InputGroup, InputGroupAddon, InputGroupInput } from "ui/input-group";
import { PlusIcon, SearchIcon } from "lucide-react";
import { type ColumnDef } from "@tanstack/react-table";
import type { Category } from "merchant-sdk";
import { Field, FieldLabel } from "ui/field";
import { format } from "date-fns";

const columns: ColumnDef<Category>[] = [
  {
    accessorKey: "id",
    header: "ID",
  },
  {
    accessorKey: "name",
    header: "Name",
  },
  {
    accessorKey: "createdAt",
    header: "Created At",
    cell: ({row}) => format(new Date(row.original.createdAt), "MM/dd/yyyy hh:mm a")
  },
];

export function ListCategoriesView() {
  const categories = useQuery(getListCategoriesQueryOptions());

  return (
    <div className="space-y-4">
      <div className="flex gap-4 items-end justify-between">
        <Field className="max-w-xs">
          <FieldLabel>Search</FieldLabel>
          <InputGroup>
            <InputGroupInput placeholder="Search categories..." />
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
          </InputGroup>
        </Field>
        <Link to="/app/products/categories/create">
          <Button>
            <PlusIcon /> Category
          </Button>
        </Link>
      </div>
      <DataTable data={categories.data?.items ?? []} columns={columns} />
    </div>
  );
}
