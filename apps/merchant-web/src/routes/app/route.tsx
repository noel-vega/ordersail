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

export const Route = createFileRoute("/app")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
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
