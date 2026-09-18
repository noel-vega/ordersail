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
import { RecoveryCodesReveal } from "../../mfa/components/recovery-codes-reveal";
import { useRegisterPasskeyMutation } from "../passkeys.hooks";
import { PasskeyCeremonyError, runRegistration } from "../webauthn";

// Open state is derived from `optionsJSON` rather than owned as a boolean,
// matching EnrollMfaDialog: the parent has already made the
// register/options call by the time this renders, so "we have options" and
// "the dialog is open" are the same fact and can't drift apart.
export function AddPasskeyDialog(props: {
  optionsJSON: Record<string, unknown> | null;
  onOpenChange: (open: boolean) => void;
  onRegistered: () => void;
}) {
  const register = useRegisterPasskeyMutation();
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  const open = props.optionsJSON !== null;

  // Same rule as the MFA enrollment dialog: once the one-time recovery codes
  // are showing, Escape / the backdrop / the X must not dismiss. This is the
  // only time the user will ever see them, and for a passkey-only user they
  // are the entire recovery story.
  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && codes) return;
    if (!nextOpen) close();
  }

  function close() {
    props.onOpenChange(false);
    // let the dialog animate out before resetting
    setTimeout(() => {
      setNickname("");
      setError(null);
      setCodes(null);
    }, 200);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!props.optionsJSON) return;

    try {
      const response = await runRegistration(props.optionsJSON);
      const result = await register.mutateAsync({
        response: response as unknown as Record<string, unknown>,
        ...(nickname.trim() ? { nickname: nickname.trim() } : {}),
      });

      // only present when this was the user's first factor of any kind
      if (result?.recoveryCodes?.length) {
        setCodes(result.recoveryCodes);
        return;
      }
      props.onRegistered();
      close();
    } catch (err) {
      if (err instanceof PasskeyCeremonyError) {
        // a dismissed prompt isn't an error worth showing
        if (!err.silent) setError(err.message);
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : "Couldn't add this passkey — try again.",
      );
    }
  }

  function finishAfterCodes() {
    props.onRegistered();
    close();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={!codes}>
        {codes ? (
          <RecoveryCodesReveal codes={codes} onDone={finishAfterCodes} />
        ) : (
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>Add a passkey</DialogTitle>
              <DialogDescription>
                Your device will ask you to confirm with Face ID, Touch ID,
                Windows Hello or your screen lock. Give it a name so you can
                tell your passkeys apart later.
              </DialogDescription>
            </DialogHeader>

            <Field className="my-4">
              <FieldLabel>Name</FieldLabel>
              <Input
                autoFocus
                maxLength={60}
                value={nickname}
                onChange={(e) => setNickname(e.currentTarget.value)}
                placeholder="MacBook"
              />
            </Field>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>
                Cancel
              </DialogClose>
              <Button type="submit" disabled={register.isPending}>
                {register.isPending ? "Adding..." : "Continue"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
