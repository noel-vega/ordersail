import { Link, getRouteApi } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { type ColumnDef } from "@tanstack/react-table";
import type { Category } from "merchant-sdk";
import { format } from "date-fns";
import { Button } from "ui/button";
import { Can } from "../../../components/can";
import { DataTable } from "../../../components/data-table";
import { DataTablePagination } from "../../../components/data-table-pagination";
import { ListSearchInput } from "../../../components/list-search-input";
import { PAGE_SIZE } from "../../../lib/list-search";
import { useListCategoriesQuery } from "../categories.hooks";

const route = getRouteApi("/app/products/categories/");

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
    cell: ({ row }) =>
      format(new Date(row.original.createdAt), "MM/dd/yyyy hh:mm a"),
  },
];

export function ListCategoriesView() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const categories = useListCategoriesQuery(search);

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
    </div>
  );
}
