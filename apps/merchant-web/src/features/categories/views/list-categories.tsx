import { useState } from "react";
import { Link, getRouteApi } from "@tanstack/react-router";
import { MoreVerticalIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type ColumnDef, type Row } from "@tanstack/react-table";
import type { CategoryListItem } from "merchant-sdk";
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
import { useDeleteCategoryMutation, useListCategoriesQuery } from "../categories.hooks";
import { EditCategorySheet } from "./edit-category-sheet";

const route = getRouteApi("/app/products/categories/");

function getColumns(handlers: {
  onEdit: (category: CategoryListItem) => void;
  onDelete: (category: CategoryListItem) => void;
  canWrite: boolean;
}): ColumnDef<CategoryListItem>[] {
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
            cell: ({ row }: { row: Row<CategoryListItem> }) => (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Category actions"
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

export function ListCategoriesView() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const categories = useListCategoriesQuery(search);
  const canWrite = usePermissions().has("products:write");
  const [editingCategory, setEditingCategory] = useState<CategoryListItem | null>(null);
  const [deletingCategory, setDeletingCategory] = useState<CategoryListItem | null>(null);
  const deleteCategory = useDeleteCategoryMutation();

  const columns = getColumns({
    onEdit: (category) => setEditingCategory(category),
    onDelete: (category) => setDeletingCategory(category),
    canWrite,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <ListSearchInput
          initialValue={search.q}
          placeholder="Search categories..."
          onDebouncedChange={(q) =>
            navigate({ search: (prev) => ({ ...prev, q, page: 1 }) })
          }
        />
        <Can permission="products:write">
          <Link to="/app/products/categories/create">
            <Button>
              <PlusIcon /> Category
            </Button>
          </Link>
        </Can>
      </div>
      <DataTable data={categories.data?.items ?? []} columns={columns} />
      <DataTablePagination
        page={search.page}
        pageSize={PAGE_SIZE}
        total={categories.data?.total ?? 0}
        onPageChange={(page) =>
          navigate({ search: (prev) => ({ ...prev, page }) })
        }
      />

      <EditCategorySheet
        category={editingCategory}
        open={editingCategory !== null}
        onOpenChange={(open) => !open && setEditingCategory(null)}
      />

      <AlertDialog
        open={deletingCategory !== null}
        onOpenChange={(open) => !open && setDeletingCategory(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deletingCategory?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingCategory && deletingCategory.productCount > 0
                ? `Used by ${deletingCategory.productCount} product${deletingCategory.productCount === 1 ? "" : "s"} — they'll be unlinked. This action cannot be undone.`
                : "This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteCategory.isPending}
              onClick={() => {
                if (!deletingCategory) return;
                deleteCategory.mutate(deletingCategory.id, {
                  onSuccess: () => setDeletingCategory(null),
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
