import { Link, getRouteApi } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { type ColumnDef, type Row } from "@tanstack/react-table";
import type { Product } from "merchant-sdk";
import { format } from "date-fns";
import { Button } from "ui/button";
import { cn } from "ui/utils";
import { Can } from "../../../components/can";
import { DataTable } from "../../../components/data-table";
import { DataTablePagination } from "../../../components/data-table-pagination";
import { ListSearchInput } from "../../../components/list-search-input";
import { PAGE_SIZE } from "../../../lib/list-search";
import {
  PRODUCT_STATUSES,
  useListProductsQuery,
  type ProductListSearch,
} from "../products.hooks";

const route = getRouteApi("/app/products/");

const columns: ColumnDef<Product>[] = [
  {
    id: "thumbnail",
    header: "",
    cell: ({ row }) =>
      row.original.thumbnailUrl ? (
        <img
          src={row.original.thumbnailUrl}
          alt=""
          className="size-10 rounded-md object-cover"
        />
      ) : (
        <div className="size-10 rounded-md bg-muted" />
      ),
  },
  {
    accessorKey: "id",
    header: "ID",
  },
  {
    accessorKey: "name",
    header: "Name",
  },
  {
    accessorKey: "status",
    header: "Status",
  },
  {
    accessorKey: "createdAt",
    header: "Created At",
    cell: ({ row }) =>
      format(new Date(row.original.createdAt), "MM/dd/yyyy hh:mm a"),
  },
];

export function ProductListView() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const products = useListProductsQuery(search);

  const total = products.data?.total ?? 0;
  const isFiltered = !!search.q || !!search.status;
  // a genuinely empty catalog (not a search that returned nothing) — guide
  // the merchant to their first product instead of showing an empty table
  const showGuidedEmptyState =
    total === 0 && !isFiltered && !products.isLoading;

  const setStatus = (status: ProductListSearch["status"]) =>
    navigate({ search: (prev) => ({ ...prev, status, page: 1 }) });

  const handleRowClick = (row: Row<Product>) => {
    navigate({ to: "/app/products/$id", params: { id: row.original.id } });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <ListSearchInput
          initialValue={search.q}
          placeholder="Search products..."
          onDebouncedChange={(q) =>
            navigate({ search: (prev) => ({ ...prev, q, page: 1 }) })
          }
        />
        <Can permission="products:write">
          <Link to="/app/products/create">
            <Button>
              <PlusIcon /> Product
            </Button>
          </Link>
        </Can>
      </div>

      {!showGuidedEmptyState && (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              !search.status && "border-primary bg-primary/5 text-primary",
            )}
            onClick={() => setStatus(undefined)}
          >
            All
          </Button>
          {PRODUCT_STATUSES.map((s) => (
            <Button
              key={s}
              type="button"
              variant="outline"
              size="sm"
              className={cn(
                "capitalize",
                search.status === s &&
                  "border-primary bg-primary/5 text-primary",
              )}
              onClick={() => setStatus(s)}
            >
              {s}
            </Button>
          ))}
        </div>
      )}

      {showGuidedEmptyState ? (
        <div className="rounded-md border border-dashed py-16 text-center">
          <p className="text-sm text-muted-foreground">
            No products yet — add your first one to start selling.
          </p>
          <Can permission="products:write">
            <Link to="/app/products/create">
              <Button className="mt-4">
                <PlusIcon /> Add your first product
              </Button>
            </Link>
          </Can>
        </div>
      ) : (
        <>
          <DataTable
            onRowClick={handleRowClick}
            data={products.data?.items ?? []}
            columns={columns}
          />
          <DataTablePagination
            page={search.page}
            pageSize={PAGE_SIZE}
            total={total}
            onPageChange={(page) =>
              navigate({ search: (prev) => ({ ...prev, page }) })
            }
          />
        </>
      )}
    </div>
  );
}
