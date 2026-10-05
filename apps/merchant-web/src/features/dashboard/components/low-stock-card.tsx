import type { UseQueryResult } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { DashboardLowStock } from "merchant-sdk"
import { Button } from "ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "ui/card"
import { Skeleton } from "ui/skeleton"
import { Can } from "../../../components/can"
import { usePermissions } from "../../auth/permission-context"
import { StockLevel } from "../../inventory/components/stock-level"
import { BY_VARIANT } from "../../inventory/inventory.hooks"

// The variants most in need of restocking (OS-195): stock summed across
// every location, at or below the account's threshold, lowest first. Each
// row links to its product for a viewer who can open it. The badges use the
// threshold from the same response, so they always match the list. "View all"
// opens the inventory list's By variant low-stock view, which applies the
// same rule, so it lists exactly the variants counted here (OS-693).
export function LowStockCard(props: {
  query: UseQueryResult<DashboardLowStock>
}) {
  const { query } = props
  const canOpenProduct = usePermissions().has("products:read")
  const items = query.data?.items
  const threshold = query.data?.lowStockThreshold

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Low stock
          {threshold !== undefined && (
            <span className="font-normal"> · at or below {threshold}</span>
          )}
        </CardTitle>
        <Can permission="inventory:read">
          <CardAction>
            <Link
              to="/app/inventory"
              search={{ view: BY_VARIANT, lowStock: true }}
              className="text-sm font-medium hover:underline"
            >
              View all
            </Link>
          </CardAction>
        </Can>
      </CardHeader>
      <CardContent>
        {query.isError && !query.data ? (
          // a failed load must not sit on the skeleton forever
          <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed py-6 text-center">
            <p className="text-sm font-medium">Couldn&apos;t load low stock</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              {query.isFetching ? "Retrying..." : "Retry"}
            </Button>
          </div>
        ) : items === undefined || threshold === undefined ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Everything is above the low-stock threshold.
          </p>
        ) : (
          <ul className="divide-y text-sm">
            {items.map((item) => {
              const name = (
                <>
                  <span className="font-medium">{item.productName}</span>
                  {item.optionsLabel && (
                    <span className="text-muted-foreground">
                      {" "}
                      · {item.optionsLabel}
                    </span>
                  )}
                </>
              )
              return (
                <li
                  key={item.variantId}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <div className="min-w-0 truncate">
                    {canOpenProduct ? (
                      <Link
                        to="/app/products/$id"
                        params={{ id: item.productId }}
                        className="hover:underline"
                      >
                        {name}
                      </Link>
                    ) : (
                      name
                    )}
                    {item.sku && (
                      <div className="truncate text-xs text-muted-foreground">
                        {item.sku}
                      </div>
                    )}
                  </div>
                  <StockLevel stock={item.stock} threshold={threshold} />
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
