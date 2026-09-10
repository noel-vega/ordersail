import { Link } from "@tanstack/react-router"
import { MapIcon } from "lucide-react"
import { Button } from "ui/button"

export function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <MapIcon />
      </div>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Page not found</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          That page doesn&apos;t exist or has moved.
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
