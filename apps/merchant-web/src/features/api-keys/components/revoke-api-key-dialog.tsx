import type { ApiKey } from "merchant-sdk"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "ui/alert-dialog"
import { useRevokeApiKeyMutation } from "../api-keys.hooks"

export function RevokeApiKeyDialog(props: {
  apiKey: ApiKey | null
  // true when this is the account's only remaining key
  isLastKey: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const revoke = useRevokeApiKeyMutation()

  async function handleConfirm() {
    if (!props.apiKey) return
    // errors surface through the global toast handler
    await revoke.mutateAsync(props.apiKey.id).catch(() => {})
    props.onOpenChange(false)
  }

  return (
    <AlertDialog
      open={props.open}
      onOpenChange={(open) => !open && props.onOpenChange(false)}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Revoke {props.apiKey?.label ?? "this API key"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This key stops working immediately — any storefront still using it
            will start getting 401s.
            {props.isLastKey
              ? " This is your last key, so your storefront will stop working until you create a new one."
              : ""}{" "}
            This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep key</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={revoke.isPending}
            onClick={handleConfirm}
          >
            {revoke.isPending ? "Revoking..." : "Revoke key"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
