import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getListLocationsQueryOptions } from "../locations.hooks";
import { DataTable } from "../../../components/data-table";
import { Button } from "ui/button";
import { Link } from "@tanstack/react-router";
import { InputGroup, InputGroupAddon, InputGroupInput } from "ui/input-group";
import { MoreVerticalIcon, PencilIcon, PlusIcon, SearchIcon } from "lucide-react";
import { type ColumnDef } from "@tanstack/react-table";
import type { Location } from "merchant-sdk";
import { Field, FieldLabel } from "ui/field";
import { format } from "date-fns";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
import { EditLocationSheet } from "./edit-location-sheet";

function formatAddress(location: Location) {
  if (!location.addressLine1) return "—";
  return [location.addressCity, location.addressState].filter(Boolean).join(", ");
}

function getColumns(handlers: {
  onEdit: (location: Location) => void;
}): ColumnDef<Location>[] {
  return [
    {
      accessorKey: "id",
      header: "ID",
    },
    {
      accessorKey: "name",
      header: "Name",
    },
    {
      id: "address",
      header: "Address",
      cell: ({ row }) => formatAddress(row.original),
    },
    {
      accessorKey: "createdAt",
      header: "Created At",
      cell: ({ row }) =>
        format(new Date(row.original.createdAt), "MM/dd/yyyy hh:mm a"),
    },
    {
      id: "actions",
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Location actions"
              />
            }
          >
            <MoreVerticalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => handlers.onEdit(row.original)}>
              <PencilIcon /> Edit address
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];
}

export function ListLocationsView() {
  const locations = useQuery(getListLocationsQueryOptions());
  const [editingLocation, setEditingLocation] = useState<Location | null>(null);

  const columns = getColumns({ onEdit: (location) => setEditingLocation(location) });

  return (
    <div className="space-y-4">
      <div className="flex gap-4 items-end justify-between">
        <Field className="max-w-xs">
          <FieldLabel>Search</FieldLabel>
          <InputGroup>
            <InputGroupInput placeholder="Search locations..." />
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
          </InputGroup>
        </Field>
        <Link to="/app/locations/create">
          <Button>
            <PlusIcon /> Location
          </Button>
        </Link>
      </div>
      <DataTable data={locations.data?.items ?? []} columns={columns} />

      <EditLocationSheet
        location={editingLocation}
        open={editingLocation !== null}
        onOpenChange={(open) => !open && setEditingLocation(null)}
      />
    </div>
  );
}
