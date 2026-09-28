import { Link } from "@tanstack/react-router"
import type { DashboardLowStock } from "merchant-sdk"
import { Card, CardContent, CardHeader, CardTitle } from "ui/card"
import { Skeleton } from "ui/skeleton"
import { usePermissions } from "../../auth/permission-context"
import { StockLevel } from "../../inventory/components/stock-level"

// The variants most in need of restocking (OS-195): stock summed across
// every location, at or below the account's threshold, lowest first. Each
// row links to its product for a viewer who can open it. The badges use the
// threshold from the same response, so they always match the list.
export function LowStockCard(props: { lowStock?: DashboardLowStock }) {
  const canOpenProduct = usePermissions().has("products:read")
  const items = props.lowStock?.items
  const threshold = props.lowStock?.lowStockThreshold

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Low stock
          {threshold !== undefined && (
            <span className="font-normal"> · at or below {threshold}</span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {items === undefined || threshold === undefined ? (
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
