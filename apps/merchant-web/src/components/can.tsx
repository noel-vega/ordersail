import type { ReactNode } from "react"
import { usePermissions } from "../features/auth/permission-context"

type CanProps = { children: ReactNode; fallback?: ReactNode } & (
  | { permission: string; anyOf?: never; allOf?: never }
  | { anyOf: string[]; permission?: never; allOf?: never }
  | { allOf: string[]; permission?: never; anyOf?: never }
)

// Renders `children` only when the current user holds the required
// permission(s), else `fallback` (default: nothing). Purely a UI convenience —
// the API enforces the same rule.
export function Can(props: CanProps) {
  const perms = usePermissions()

  let allowed = false
  if (props.permission !== undefined) allowed = perms.has(props.permission)
  else if (props.anyOf !== undefined) allowed = perms.hasAny(props.anyOf)
  else if (props.allOf !== undefined) allowed = perms.hasAll(props.allOf)

  return <>{allowed ? props.children : (props.fallback ?? null)}</>
}
