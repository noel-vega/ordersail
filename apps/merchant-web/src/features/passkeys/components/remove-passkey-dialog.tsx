import { useState } from "react";
import { ApiError, type Passkey } from "merchant-sdk";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "ui/dialog";
import { Field, FieldLabel } from "ui/field";
import { Input } from "ui/input";
import { Button } from "ui/button";
import { toast } from "ui/sonner";
import { useRemovePasskeyMutation } from "../passkeys.hooks";

// Password re-entry mirrors DisableMfaDialog — removing a factor takes the
// same bar as disabling one, since the point of a second factor is that a
// password alone shouldn't be enough to weaken an account.
export function RemovePasskeyDialog(props: {
  passkey: Passkey | null;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useRemovePasskeyMutation();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const open = props.passkey !== null;

  function close() {
    props.onOpenChange(false);
    setTimeout(() => {
      setPassword("");
      setError(null);
    }, 200);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!props.passkey) return;
    try {
      await remove.mutateAsync({ id: props.passkey.id, password });
      toast.success("Passkey removed");
      close();
    } catch (err) {
      // the API refuses with a 409 when this is the caller's last factor and
      // their account requires MFA — that message is worth showing verbatim
      setError(
        err instanceof ApiError
          ? err.message
          : "Couldn't remove this passkey — try again.",
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Remove {props.passkey?.nickname}</DialogTitle>
            <DialogDescription>
              You won&apos;t be able to sign in with this passkey any more. It
              stays on your device until you delete it there too.
            </DialogDescription>
          </DialogHeader>

          <Field className="my-4">
            <FieldLabel>Current password</FieldLabel>
            <Input
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
            />
          </Field>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              type="submit"
              variant="destructive"
              disabled={remove.isPending || !password}
            >
              {remove.isPending ? "Removing..." : "Remove passkey"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
