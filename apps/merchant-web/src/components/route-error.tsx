import { useEffect } from "react";
import { Link, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { TriangleAlertIcon } from "lucide-react";
import { ApiError } from "merchant-sdk";
import { Button } from "ui/button";
import { AccessDenied } from "../features/errors/access-denied.view";

function friendlyMessage(error: Error): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Your session expired. Please sign in again.";
    if (error.status >= 500)
      return "The server had a problem. Try again in a moment.";
    return error.message;
  }
  return "We couldn't load this page. Try again in a moment.";
}

// Router-wide error component: rendered by `defaultErrorComponent` for a
// loader / beforeLoad failure, and by the <CatchBoundary> in the app shell for
// a render-time crash.
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();

  // an unrecoverable 401 means the session is gone — bounce to sign-in
  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) {
      void router.navigate({ to: "/signin" });
    }
  }, [error, router]);

  // a 403 that reached here (e.g. a query for a section whose permission was
  // revoked mid-session) — show the access-denied view, not a scary error card
  if (error instanceof ApiError && error.status === 403) {
    return <AccessDenied />;
  }

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <TriangleAlertIcon />
      </div>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {friendlyMessage(error)}
        </p>
      </div>
      {import.meta.env.DEV && error.message && (
        <pre className="max-w-md overflow-x-auto rounded-md bg-muted p-3 text-left text-xs text-muted-foreground">
          {error.message}
        </pre>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          onClick={() => {
            reset();
            void router.invalidate();
          }}
        >
          Try again
        </Button>
        <Link to="/app">
          <Button type="button" variant="outline">
            Go to dashboard
          </Button>
        </Link>
      </div>
    </div>
  );
}
