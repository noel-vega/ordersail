import ReactDOM from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import "ui/styles.css";

// Import the generated route tree
import { routeTree } from "./routeTree.gen";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/react-query-client";
import { TooltipProvider } from "ui/tooltip";
import { RouteError } from "./components/route-error";
import { NotFound } from "./components/not-found";
import { TableSkeleton } from "./components/skeletons";

// Create a new router instance
export const router = createRouter({
  routeTree,
  defaultErrorComponent: RouteError,
  defaultNotFoundComponent: NotFound,
  // most /app screens are lists; detail/form routes override pendingComponent.
  // 200ms delay + 300ms min so a warm-cache navigation never flashes a skeleton.
  defaultPendingComponent: TableSkeleton,
  defaultPendingMs: 200,
  defaultPendingMinMs: 300,
});

// Register the router instance for type safety
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }

  interface StaticDataRouteOption {
    breadcrumb?: string | ((params: Record<string, unknown>) => string);
  }
}

// Render the app
const rootElement = document.getElementById("root")!;
if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}
