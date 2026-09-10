import { createFileRoute, Outlet } from "@tanstack/react-router";
import { requirePermission } from "../../../lib/require-permission";

export const Route = createFileRoute("/app/products")({
  staticData: { breadcrumb: "Products" },
  beforeLoad: ({ context }) => {
    requirePermission(context, "products:read");
  },
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <div>
      <Outlet />
    </div>
  );
}
