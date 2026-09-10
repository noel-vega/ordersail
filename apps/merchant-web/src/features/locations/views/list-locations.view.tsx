import { useState } from "react";
import { Link, getRouteApi } from "@tanstack/react-router";
import { Button } from "ui/button";
import { MoreVerticalIcon, PencilIcon, PlusIcon } from "lucide-react";
import { type ColumnDef } from "@tanstack/react-table";
import type { Location } from "merchant-sdk";
import { format } from "date-fns";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
import { DataTable } from "../../../components/data-table";
import { DataTablePagination } from "../../../components/data-table-pagination";
import { ListSearchInput } from "../../../components/list-search-input";
import { PAGE_SIZE } from "../../../lib/list-search";
import { useListLocationsQuery } from "../locations.hooks";
import { EditLocationSheet } from "./edit-location-sheet";

const route = getRouteApi("/app/locations/");

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
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const locations = useListLocationsQuery(search);
  const [editingLocation, setEditingLocation] = useState<Location | null>(null);

  const columns = getColumns({ onEdit: (location) => setEditingLocation(location) });

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <ListSearchInput
          initialValue={search.q}
          placeholder="Search locations..."
          onDebouncedChange={(q) =>
            navigate({ search: (prev) => ({ ...prev, q, page: 1 }) })
          }
        />
        <Link to="/app/locations/create">
          <Button>
            <PlusIcon /> Location
          </Button>
        </Link>
      </div>
      <DataTable data={locations.data?.items ?? []} columns={columns} />
      <DataTablePagination
        page={search.page}
        pageSize={PAGE_SIZE}
        total={locations.data?.total ?? 0}
        onPageChange={(page) =>
          navigate({ search: (prev) => ({ ...prev, page }) })
        }
      />

      <EditLocationSheet
        location={editingLocation}
        open={editingLocation !== null}
        onOpenChange={(open) => !open && setEditingLocation(null)}
      />
    </div>
  );
}
