import { Skeleton } from "ui/skeleton"

// Reusable loading placeholders for route `pendingComponent`s. `TableSkeleton`
// is the router-wide default (most /app screens are lists); detail and form
// routes opt into the other two.

export function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="overflow-hidden rounded-md border">
        <div className="border-b bg-muted/50 p-3">
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="divide-y">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 p-3">
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="grid grid-cols-2 gap-8">
        {[0, 1].map((col) => (
          <div key={col} className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ))}
      </div>
      <Skeleton className="h-48 w-full" />
    </div>
  )
}

export function FormSkeleton({ fields = 4 }: { fields?: number }) {
  return (
    <div className="max-w-xl space-y-4">
      <Skeleton className="h-7 w-48" />
      {Array.from({ length: fields }).map((_, i) => (
        <div key={i} className="space-y-1.5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
      <Skeleton className="h-9 w-28" />
    </div>
  )
}
