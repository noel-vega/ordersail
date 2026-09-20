import type React from "react";
import {
  CatchBoundary,
  createFileRoute,
  Outlet,
  redirect,
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

// where each gate sends the caller — completing it is how the gate is
// satisfied (EmailVerifiedGuard / MfaEnrollmentGuard server-side). The email
// lobby lives outside /app: every app route would 403 anyway
const MFA_ENROLLMENT_ROUTE = "/app/me/security";

export const Route = createFileRoute("/app")({
  // load the current user's effective permissions once on entering /app and
  // expose them on the router context so child routes' beforeLoad can gate.
  // Also redirects into forced MFA enrollment (OS-475) when the account
  // requires it and this user hasn't finished — mirrors requirePermission()'s
  // redirect-to-/app/403 shape, but applies to every route instead of an
  // opt-in few, since the backend guard blocks almost everything too.
  beforeLoad: async ({ location }) => {
    const me = await queryClient.ensureQueryData(getAuthMeQueryOptions());
    // email first: MFA enrollment itself requires a verified email, so
    // sending an unverified user to the MFA page would dead-end them
    if (me && !me.emailVerified) {
      throw redirect({ to: "/verify-email" });
    }
    if (
      me &&
      !me.mfaEnrollmentSatisfied &&
      location.pathname !== MFA_ENROLLMENT_ROUTE
    ) {
      throw redirect({ to: MFA_ENROLLMENT_ROUTE, search: { required: true } });
    }
    return {
      userId: me?.userId,
      permissions: new Set(me?.permissions ?? []),
    };
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
