import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { AccessDenied } from "../../features/errors/access-denied.view"

// kept under /app so the sidebar stays — requirePermission() redirects here
export const Route = createFileRoute("/app/403")({
  validateSearch: z.object({ need: z.string().optional() }),
  staticData: { breadcrumb: "Access denied" },
  component: RouteComponent,
})

function RouteComponent() {
  const { need } = Route.useSearch()
  return <AccessDenied need={need} />
}
