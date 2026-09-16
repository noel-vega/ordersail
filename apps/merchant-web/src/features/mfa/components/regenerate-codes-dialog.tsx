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
import { useRegenerateRecoveryCodesMutation } from "../mfa.hooks";
import { RecoveryCodesReveal } from "./recovery-codes-reveal";

export function RegenerateCodesDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const regenerate = useRegenerateRecoveryCodesMutation();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  function close() {
    props.onOpenChange(false);
    setTimeout(() => {
      setPassword("");
      setError(null);
      setCodes(null);
    }, 200);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const result = await regenerate.mutateAsync({ password });
      if (result) setCodes(result.recoveryCodes);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Couldn't regenerate — try again.",
      );
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        {codes ? (
          <RecoveryCodesReveal codes={codes} onDone={close} />
        ) : (
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>Regenerate recovery codes</DialogTitle>
              <DialogDescription>
                Your existing recovery codes stop working immediately.
                Confirm your password to generate a fresh batch.
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
                disabled={regenerate.isPending || !password}
              >
                {regenerate.isPending ? "Generating..." : "Regenerate codes"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
