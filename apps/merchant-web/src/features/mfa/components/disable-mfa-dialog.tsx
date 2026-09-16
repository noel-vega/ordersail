import { useState } from "react";
import { ApiError } from "merchant-sdk";
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
import { useDisableMfaMutation } from "../mfa.hooks";

export function DisableMfaDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const disable = useDisableMfaMutation();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

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
    try {
      await disable.mutateAsync({ password });
      toast.success("Two-factor authentication disabled");
      close();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Couldn't disable — try again.",
      );
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Disable two-factor authentication</DialogTitle>
            <DialogDescription>
              This removes your authenticator and every recovery code.
              Confirm your password to continue.
            </DialogDescription>
          </DialogHeader>

          <Field className="my-4">
            <FieldLabel>Current password</FieldLabel>
            <Input
              autoFocus
              type="password"
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
              disabled={disable.isPending || !password}
            >
              {disable.isPending ? "Disabling..." : "Disable"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
