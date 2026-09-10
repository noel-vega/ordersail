import { Link } from "@tanstack/react-router"
import { LockIcon } from "lucide-react"
import { Button } from "ui/button"

// Shown when the current user lacks a permission — from the /app/403 route
// (deep-link blocked in beforeLoad) or from RouteError on a 403 from a query.
export function AccessDenied({ need }: { need?: string }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <LockIcon />
      </div>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">You don&apos;t have access to this</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {need
            ? `This page needs the "${need}" permission. Ask an account owner to add it to one of your roles.`
            : "Ask an account owner to grant your role the permission for this section."}
        </p>
      </div>
      <Link to="/app">
        <Button type="button" variant="outline">
          Go to dashboard
        </Button>
      </Link>
    </div>
  )
}
