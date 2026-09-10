import { redirect } from "@tanstack/react-router"

// Call from a route's `beforeLoad` to block a deep-link when the current user
// lacks a permission. Reads the permission set the /app route put on the
// router context (see routes/app/route.tsx). Redirects to /app/403 rather than
// throwing so the sidebar stays and the message names the missing key.
export function requirePermission(
  context: { permissions: Set<string> },
  permission: string,
): void {
  if (!context.permissions.has(permission)) {
    throw redirect({ to: "/app/403", search: { need: permission } })
  }
}
