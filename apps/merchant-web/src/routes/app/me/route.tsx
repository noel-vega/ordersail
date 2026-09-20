import {
  createFileRoute,
  Link,
  Outlet,
  useLocation,
} from "@tanstack/react-router";
import { cn } from "ui/utils";

// Everything scoped to the signed-in person lives under /app/me: their
// profile (OS-386) and their security factors today, notifications and saved
// views later. `me` names whose, not what, and mirrors the API namespace
// (GET /auth/me). Not `/app/account` — an Account here is the merchant
// tenant, which is what /app/settings edits.
//
// Deliberately no requirePermission(): every authenticated user reaches their
// own page, including one holding zero permissions.
const TABS = [
  { to: "/app/me/profile", label: "Profile" },
  { to: "/app/me/security", label: "Security" },
] as const;

export const Route = createFileRoute("/app/me")({
  // "You › Security" reads correctly where "Me › Security" doesn't, so the
  // breadcrumb deliberately doesn't match the URL segment.
  staticData: { breadcrumb: "You" },
  component: RouteComponent,
});

function RouteComponent() {
  const pathname = useLocation({ select: (location) => location.pathname });

  return (
    <div className="space-y-6">
      <nav aria-label="Your profile" className="flex gap-1 border-b">
        {TABS.map((tab) => {
          // startsWith as well as equality so a tab that grows children in
          // M3/M4 stays highlighted without reworking this
          const isActive =
            pathname === tab.to || pathname.startsWith(`${tab.to}/`);
          return (
            <Link
              key={tab.to}
              to={tab.to}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
      <Outlet />
    </div>
  );
}
