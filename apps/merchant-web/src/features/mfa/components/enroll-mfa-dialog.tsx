import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
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
import { useConfirmMfaMutation } from "../mfa.hooks";
import { RecoveryCodesReveal } from "./recovery-codes-reveal";

function extractSecret(otpauthUrl: string): string | null {
  try {
    return new URL(otpauthUrl).searchParams.get("secret");
  } catch {
    return null;
  }
}

// `otpauthUrl` is only non-null once the parent's enroll() call has already
// resolved — this dialog owns just the remaining two steps (confirm the
// code, then save the recovery codes), not the initial enroll request.
export function EnrollMfaDialog(props: {
  otpauthUrl: string | null;
  onOpenChange: (open: boolean) => void;
  // fired once enrollment is complete AND the recovery codes have been
  // acknowledged — the factor-required flow uses it to resume whatever the
  // user was trying to do. Optional: the Security page just closes.
  onConfirmed?: () => void;
  // the caller already holds the password the user typed on this same screen
  // (joining via an invite, OS-494) — submit it rather than asking again for
  // something they set ten seconds ago. Everywhere else it stays unset and
  // the re-entry prompt does its job.
  knownPassword?: string;
}) {
  const confirm = useConfirmMfaMutation();
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  const effectivePassword = props.knownPassword ?? password;
  const open = props.otpauthUrl !== null;

  // Once the one-time recovery codes are showing, Escape/backdrop/the X
  // button must not be able to dismiss this — that's the only copy the
  // user will ever see, and losing it silently would leave MFA enabled
  // with no saved recovery method. Only the explicit "I've saved these
  // codes" button (which calls close() directly, not through here) may
  // close the dialog at that point.
  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && codes) return;
    if (!nextOpen) close();
  }

  function close() {
    if (codes) props.onConfirmed?.();
    props.onOpenChange(false);
    // let the dialog animate out before resetting
    setTimeout(() => {
      setCode("");
      setPassword("");
      setError(null);
      setCodes(null);
    }, 200);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const result = await confirm.mutateAsync({
        code,
        password: effectivePassword,
      });
      if (result) setCodes(result.recoveryCodes);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Couldn't verify — try again.",
      );
    }
  }

  const secret = props.otpauthUrl ? extractSecret(props.otpauthUrl) : null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={!codes}>
        {codes ? (
          <RecoveryCodesReveal codes={codes} onDone={close} />
        ) : (
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>Set up two-factor authentication</DialogTitle>
              <DialogDescription>
                Scan this QR code with an authenticator app (Google
                Authenticator, 1Password, Authy), then enter the 6-digit code it
                shows{props.knownPassword === undefined ? " along with your password" : ""}.
              </DialogDescription>
            </DialogHeader>

            {props.otpauthUrl && (
              <div className="flex justify-center py-4">
                <QRCodeSVG value={props.otpauthUrl} size={180} />
              </div>
            )}

            {secret && (
              <p className="break-all text-center text-sm text-muted-foreground">
                Can&apos;t scan it? Enter this code manually:{" "}
                <span className="font-mono">{secret}</span>
              </p>
            )}

            <Field className="my-4">
              <FieldLabel>6-digit code</FieldLabel>
              <Input
                autoFocus
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.currentTarget.value)}
                placeholder="123456"
              />
            </Field>

            {props.knownPassword === undefined && (
              <Field className="mb-4">
                <FieldLabel>Current password</FieldLabel>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.currentTarget.value)}
                />
              </Field>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>
                Cancel
              </DialogClose>
              <Button
                type="submit"
                disabled={
                  confirm.isPending || code.length !== 6 || !effectivePassword
                }
              >
                {confirm.isPending ? "Verifying..." : "Verify and enable"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
