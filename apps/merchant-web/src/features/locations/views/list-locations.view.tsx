import { useState } from "react";
import { Link, getRouteApi } from "@tanstack/react-router";
import { Button } from "ui/button";
import { MoreVerticalIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type ColumnDef, type Row } from "@tanstack/react-table";
import type { Location } from "merchant-sdk";
import { format } from "date-fns";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
import { Can } from "../../../components/can";
import { DataTable } from "../../../components/data-table";
import { DataTablePagination } from "../../../components/data-table-pagination";
import { ListSearchInput } from "../../../components/list-search-input";
import { PAGE_SIZE } from "../../../lib/list-search";
import { usePermissions } from "../../auth/permission-context";
import { useDeleteLocationMutation, useListLocationsQuery } from "../locations.hooks";
import { EditLocationSheet } from "./edit-location-sheet";

const route = getRouteApi("/app/locations/");

function formatAddress(location: Location) {
  if (!location.addressLine1) return "—";
  return [location.addressCity, location.addressState].filter(Boolean).join(", ");
}

function getColumns(handlers: {
  onEdit: (location: Location) => void;
  onDelete: (location: Location) => void;
  canWrite: boolean;
  canDelete: boolean;
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
    ...(handlers.canWrite || handlers.canDelete
      ? [
          {
            id: "actions",
            cell: ({ row }: { row: Row<Location> }) => (
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
                  {handlers.canWrite && (
                    <DropdownMenuItem onClick={() => handlers.onEdit(row.original)}>
                      <PencilIcon /> Edit address
                    </DropdownMenuItem>
                  )}
                  {handlers.canDelete && (
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => handlers.onDelete(row.original)}
                    >
                      <Trash2Icon /> Delete
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            ),
          },
        ]
      : []),
  ];
}

export function ListLocationsView() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const locations = useListLocationsQuery(search);
  const permissions = usePermissions();
  const canWrite = permissions.has("locations:write");
  const canDelete = permissions.has("locations:delete");
  const [editingLocation, setEditingLocation] = useState<Location | null>(null);
  const [deletingLocation, setDeletingLocation] = useState<Location | null>(null);
  const deleteLocation = useDeleteLocationMutation();

  const columns = getColumns({
    onEdit: (location) => setEditingLocation(location),
    onDelete: (location) => setDeletingLocation(location),
    canWrite,
    canDelete,
  });

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
        <Can permission="locations:write">
          <Link to="/app/locations/create">
            <Button>
              <PlusIcon /> Location
            </Button>
          </Link>
        </Can>
      </div>
      <DataTable
        data={locations.data?.items ?? []}
        columns={columns}
        emptyMessage={search.q ? undefined : "No locations yet."}
      />
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

      <AlertDialog
        open={deletingLocation !== null}
        onOpenChange={(open) => !open && setDeletingLocation(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deletingLocation?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteLocation.isPending}
              onClick={() => {
                if (!deletingLocation) return;
                deleteLocation.mutate(deletingLocation.id, {
                  onSuccess: () => setDeletingLocation(null),
                });
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
