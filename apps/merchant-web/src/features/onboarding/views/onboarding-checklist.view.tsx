import { Link } from "@tanstack/react-router"
import { CheckCircle2Icon, CircleIcon } from "lucide-react"
import type { LinkProps } from "@tanstack/react-router"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "ui/card"
import { Button } from "ui/button"
import { cn } from "ui/utils"
import { Can } from "../../../components/can"
import { useOnboardingStatusQuery } from "../onboarding.hooks"

type ChecklistItem = {
  label: string
  done: boolean
  cta: string
  to: LinkProps["to"]
  search?: LinkProps["search"]
  // the CTA only shows for a user who can actually do the step
  permission: string
}

export function OnboardingChecklist() {
  const status = useOnboardingStatusQuery()

  // hidden while loading (avoids a flash of an all-unchecked card) and once
  // the merchant has finished every step
  if (!status.data || status.data.complete) return null

  const items: ChecklistItem[] = [
    {
      label: "Connect Stripe so you can accept payments",
      done: status.data.stripeConnected,
      cta: "Connect Stripe",
      to: "/app/payments",
      // auto-open the embedded Stripe onboarding flow on arrival (OS-167)
      search: { onboarding: true },
      permission: "payments:write",
    },
    {
      label: "Add your location's address so shipping can be quoted",
      done: status.data.hasCompleteLocation,
      cta: "Add address",
      to: "/app/locations",
      permission: "locations:write",
    },
    {
      label: "Add your first product and set it active",
      done: status.data.hasActiveProduct,
      cta: "Add a product",
      to: "/app/products/create",
      permission: "products:write",
    },
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle>Finish setting up your store</CardTitle>
        <CardDescription>
          A few things left before you can take a real order.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.map((item) => (
          <div key={item.label} className="flex items-center gap-3">
            {item.done ? (
              <CheckCircle2Icon className="size-5 shrink-0 text-primary" />
            ) : (
              <CircleIcon className="size-5 shrink-0 text-muted-foreground" />
            )}
            <span
              className={cn(
                "flex-1 text-sm",
                item.done && "text-muted-foreground line-through",
              )}
            >
              {item.label}
            </span>
            {!item.done && (
              <Can permission={item.permission}>
                <Link to={item.to} search={item.search}>
                  <Button variant="outline" size="sm">
                    {item.cta}
                  </Button>
                </Link>
              </Can>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
