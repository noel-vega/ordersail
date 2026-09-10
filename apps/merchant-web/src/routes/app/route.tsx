import type React from "react";
import {
  CatchBoundary,
  createFileRoute,
  Outlet,
  useRouterState,
} from "@tanstack/react-router";
import { AppSidebar } from "../../components/app-sidebar";
import { SidebarInset, SidebarProvider } from "ui/sidebar";
import { AppHeader } from "../../components/app-header";
import { NavCommandMenu } from "../../components/nav-command-menu";
import { RouteError } from "../../components/route-error";
import { queryClient } from "../../lib/react-query-client";
import { getAuthMeQueryOptions } from "../../features/auth/permissions.hooks";
import { PermissionProvider } from "../../features/auth/permission-context";

export const Route = createFileRoute("/app")({
  // load the current user's effective permissions once on entering /app and
  // expose them on the router context so child routes' beforeLoad can gate
  beforeLoad: async () => {
    const me = await queryClient.ensureQueryData(getAuthMeQueryOptions());
    return { permissions: new Set(me?.permissions ?? []) };
  },
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <PermissionProvider>
      <div className="h-dvh">
        <SidebarProvider
        style={
          {
            "--header-height": "calc(var(--spacing) * 12)",
          } as React.CSSProperties
        }
      >
        <AppSidebar />
        <NavCommandMenu />
        <SidebarInset>
          <AppHeader />
          <main className="flex flex-1 flex-col p-6">
            <AppOutlet />
          </main>
          </SidebarInset>
        </SidebarProvider>
      </div>
    </PermissionProvider>
  );
}

// keeps the sidebar shell intact when a feature screen crashes at render;
// re-keyed on navigation so moving away from a broken page clears the error
function AppOutlet() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <CatchBoundary getResetKey={() => pathname} errorComponent={RouteError}>
      <Outlet />
    </CatchBoundary>
  );
}
