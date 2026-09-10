import { useState } from "react"
import type { ApiKey } from "merchant-sdk"
import { ApiError } from "merchant-sdk"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "ui/dialog"
import { Field, FieldLabel } from "ui/field"
import { Input } from "ui/input"
import { Button } from "ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "ui/input-group"
import { CopyButton } from "../../../components/copy-button"
import { useCreateApiKeyMutation } from "../api-keys.hooks"

export function CreateApiKeyDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const create = useCreateApiKeyMutation()
  const [label, setLabel] = useState("")
  const [error, setError] = useState<string | null>(null)
  // once set, the dialog swaps from the form to the key reveal
  const [created, setCreated] = useState<ApiKey | null>(null)

  function close() {
    props.onOpenChange(false)
    // let the dialog animate out before resetting
    setTimeout(() => {
      setLabel("")
      setError(null)
      setCreated(null)
    }, 200)
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      const key = await create.mutateAsync({ label: label.trim() || undefined })
      if (key) setCreated(key)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Couldn't create the key — try again.",
      )
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>API key created</DialogTitle>
              <DialogDescription>
                {created.label
                  ? `"${created.label}" is ready to use.`
                  : "Your new key is ready to use."}{" "}
                It stays visible here on the Developers page.
              </DialogDescription>
            </DialogHeader>

            <InputGroup>
              <InputGroupInput readOnly value={created.key} />
              <InputGroupAddon align="inline-end">
                <CopyButton value={created.key} label="Copy key" />
              </InputGroupAddon>
            </InputGroup>

            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
              <DialogDescription>
                A label is optional — it just helps you tell keys apart.
              </DialogDescription>
            </DialogHeader>

            <Field className="my-4">
              <FieldLabel>Label (optional)</FieldLabel>
              <Input
                autoFocus
                value={label}
                onChange={(e) => setLabel(e.currentTarget.value)}
                placeholder="e.g. Production storefront"
              />
            </Field>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>
                Cancel
              </DialogClose>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? "Creating..." : "Create key"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
