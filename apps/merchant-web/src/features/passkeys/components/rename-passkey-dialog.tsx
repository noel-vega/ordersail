import { useEffect, useState } from "react";
import { ApiError, type Passkey } from "merchant-sdk";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "ui/dialog";
import { Field, FieldLabel } from "ui/field";
import { Input } from "ui/input";
import { Button } from "ui/button";
import { useRenamePasskeyMutation } from "../passkeys.hooks";

export function RenamePasskeyDialog(props: {
  passkey: Passkey | null;
  onOpenChange: (open: boolean) => void;
}) {
  const rename = useRenamePasskeyMutation();
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState<string | null>(null);

  const open = props.passkey !== null;

  // seed the field with the current name each time a different passkey is
  // picked, rather than on every render
  useEffect(() => {
    if (props.passkey) setNickname(props.passkey.nickname);
  }, [props.passkey]);

  function close() {
    props.onOpenChange(false);
    setTimeout(() => setError(null), 200);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!props.passkey) return;
    try {
      await rename.mutateAsync({ id: props.passkey.id, nickname });
      close();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Couldn't rename — try again.",
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Rename passkey</DialogTitle>
          </DialogHeader>

          <Field className="my-4">
            <FieldLabel>Name</FieldLabel>
            <Input
              autoFocus
              maxLength={60}
              value={nickname}
              onChange={(e) => setNickname(e.currentTarget.value)}
            />
          </Field>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              type="submit"
              disabled={rename.isPending || !nickname.trim()}
            >
              {rename.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
