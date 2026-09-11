import { useState } from "react";
import { Link, getRouteApi } from "@tanstack/react-router";
import { MoreVerticalIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type ColumnDef, type Row } from "@tanstack/react-table";
import type { Brand } from "merchant-sdk";
import { format } from "date-fns";
import { Button } from "ui/button";
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
import { useDeleteBrandMutation, useListBrandsQuery } from "../brands.hooks";
import { EditBrandSheet } from "./edit-brand-sheet";

const route = getRouteApi("/app/products/brands/");

function getColumns(handlers: {
  onEdit: (brand: Brand) => void;
  onDelete: (brand: Brand) => void;
  canWrite: boolean;
}): ColumnDef<Brand>[] {
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
      accessorKey: "createdAt",
      header: "Created At",
      cell: ({ row }) =>
        format(new Date(row.original.createdAt), "MM/dd/yyyy hh:mm a"),
    },
    ...(handlers.canWrite
      ? [
          {
            id: "actions",
            cell: ({ row }: { row: Row<Brand> }) => (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Brand actions"
                    />
                  }
                >
                  <MoreVerticalIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onClick={() => handlers.onEdit(row.original)}>
                    <PencilIcon /> Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => handlers.onDelete(row.original)}
                  >
                    <Trash2Icon /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ),
          },
        ]
      : []),
  ];
}

export function ListBrandsView() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const brands = useListBrandsQuery(search);
  const canWrite = usePermissions().has("products:write");
  const [editingBrand, setEditingBrand] = useState<Brand | null>(null);
  const [deletingBrand, setDeletingBrand] = useState<Brand | null>(null);
  const deleteBrand = useDeleteBrandMutation();

  const columns = getColumns({
    onEdit: (brand) => setEditingBrand(brand),
    onDelete: (brand) => setDeletingBrand(brand),
    canWrite,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <ListSearchInput
          initialValue={search.q}
          placeholder="Search brands..."
          onDebouncedChange={(q) =>
            navigate({ search: (prev) => ({ ...prev, q, page: 1 }) })
          }
        />
        <Can permission="products:write">
          <Link to="/app/products/brands/create">
            <Button>
              <PlusIcon /> Brand
            </Button>
          </Link>
        </Can>
      </div>
      <DataTable data={brands.data?.items ?? []} columns={columns} />
      <DataTablePagination
        page={search.page}
        pageSize={PAGE_SIZE}
        total={brands.data?.total ?? 0}
        onPageChange={(page) =>
          navigate({ search: (prev) => ({ ...prev, page }) })
        }
      />

      <EditBrandSheet
        brand={editingBrand}
        open={editingBrand !== null}
        onOpenChange={(open) => !open && setEditingBrand(null)}
      />

      <AlertDialog
        open={deletingBrand !== null}
        onOpenChange={(open) => !open && setDeletingBrand(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deletingBrand?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteBrand.isPending}
              onClick={() => {
                if (!deletingBrand) return;
                deleteBrand.mutate(deletingBrand.id, {
                  onSuccess: () => setDeletingBrand(null),
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
