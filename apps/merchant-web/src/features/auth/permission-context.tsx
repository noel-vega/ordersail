import { createContext, useContext, useMemo, type ReactNode } from "react"
import { useAuthMe } from "./permissions.hooks"

export interface PermissionSet {
  permissions: string[]
  has: (key: string) => boolean
  hasAny: (keys: string[]) => boolean
  hasAll: (keys: string[]) => boolean
}

const PermissionContext = createContext<PermissionSet | null>(null)

// Fed by the /auth/me query, which /app's beforeLoad has already prefetched —
// so `me.data` is populated on first render in practice.
export function PermissionProvider({ children }: { children: ReactNode }) {
  const me = useAuthMe()

  const value = useMemo<PermissionSet>(() => {
    const keys = me.data?.permissions ?? []
    const set = new Set(keys)
    return {
      permissions: keys,
      has: (key) => set.has(key),
      hasAny: (needed) => needed.some((key) => set.has(key)),
      hasAll: (needed) => needed.every((key) => set.has(key)),
    }
  }, [me.data?.permissions])

  return (
    <PermissionContext.Provider value={value}>
      {children}
    </PermissionContext.Provider>
  )
}

export function usePermissions(): PermissionSet {
  const ctx = useContext(PermissionContext)
  if (!ctx) {
    throw new Error("usePermissions must be used within <PermissionProvider>")
  }
  return ctx
}
