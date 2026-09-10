import { useMemo } from "react"
import { usePermissions, type PermissionSet } from "../features/auth/permission-context"
import { NAV_ITEMS } from "./app-sidebar"

type NavItem = (typeof NAV_ITEMS)[number]

export function navItemVisible(
  perms: PermissionSet,
  permission: string | undefined,
): boolean {
  return permission === undefined || perms.has(permission)
}

// NAV_ITEMS filtered to the top-level sections the current user may see. Child
// links are filtered per-render by the consumer with `navItemVisible` (they
// can't be re-mapped here without widening the typed `to` literals). Used by
// both the sidebar and the Cmd-K palette so they never diverge.
export function useVisibleNavItems(): { items: readonly NavItem[]; perms: PermissionSet } {
  const perms = usePermissions()
  const items = useMemo(
    () => NAV_ITEMS.filter((item) => navItemVisible(perms, item.permission)),
    [perms],
  )
  return { items, perms }
}
