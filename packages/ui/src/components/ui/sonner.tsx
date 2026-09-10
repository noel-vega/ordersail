import * as React from "react"
import { Toaster as SonnerToaster } from "sonner"

// Thin wrapper so apps import the toaster + `toast()` from `ui/sonner` and get
// consistent defaults. `richColors` handles the error / success palette.
function Toaster(props: React.ComponentProps<typeof SonnerToaster>) {
  return <SonnerToaster richColors position="bottom-right" {...props} />
}

export { Toaster }
export { toast } from "sonner"
