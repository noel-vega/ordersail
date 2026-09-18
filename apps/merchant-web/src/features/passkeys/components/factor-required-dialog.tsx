import { useState } from "react";
import { ApiError, type MfaEnrollResponse } from "merchant-sdk";
import { KeyRoundIcon, SmartphoneIcon } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "ui/dialog";
import { Button } from "ui/button";
import { merchantApi } from "../../../lib/merchant-api-client";
import { useEnrollMfaMutation } from "../../mfa/mfa.hooks";
import { EnrollMfaDialog } from "../../mfa/components/enroll-mfa-dialog";
import { AddPasskeyDialog } from "./add-passkey-dialog";
import { browserSupportsWebAuthn } from "../webauthn";

// The one "set up a sign-in factor" flow, reached from every gated action.
//
// Both options are offered together and inline — passkey first because it's
// the better one, authenticator plainly visible below rather than behind a
// disclosure. Deliberately NOT chosen by capability detection: the browser
// can say whether a *built-in* authenticator exists, but not whether the
// user could scan a QR with their phone or plug in a security key, so a
// detection-driven branch would hide the authenticator option from some of
// the people who need it and show it to people who don't.
//
// Setting a factor up here returns the user to what they were doing, rather
// than sending them to Settings and losing the action.
export function FactorRequiredDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // what the caller was trying to do, e.g. "connect Stripe"
  action: string;
  onReady: () => void;
}) {
  const enroll = useEnrollMfaMutation();
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [passkeyOptions, setPasskeyOptions] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [enrollment, setEnrollment] = useState<MfaEnrollResponse | null>(null);

  const supportsPasskeys = browserSupportsWebAuthn();

  async function startPasskey() {
    setError(null);
    setStarting(true);
    try {
      const options = await merchantApi.passkeys.registerOptions();
      setPasskeyOptions(options as Record<string, unknown>);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Couldn't start — try again.",
      );
    } finally {
      setStarting(false);
    }
  }

  async function startAuthenticator() {
    setError(null);
    setStarting(true);
    try {
      const result = await enroll.mutateAsync();
      if (result) setEnrollment(result);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Couldn't start — try again.",
      );
    } finally {
      setStarting(false);
    }
  }

  // Both enrollment paths re-mint the caller's access token with the factor
  // claim set, so the original action can be retried straight away.
  function handleEnrolled() {
    props.onOpenChange(false);
    props.onReady();
  }

  return (
    <>
      <Dialog
        open={props.open}
        onOpenChange={(next) => !next && props.onOpenChange(false)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a second factor first</DialogTitle>
            <DialogDescription>
              Before you {props.action}, secure your account with a passkey or
              an authenticator app. It takes a few seconds, and you&apos;ll
              come straight back here.
            </DialogDescription>
          </DialogHeader>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="space-y-2 py-2">
            {supportsPasskeys && (
              <Button
                className="w-full justify-start"
                onClick={startPasskey}
                disabled={starting}
              >
                <KeyRoundIcon />
                Add a passkey
              </Button>
            )}
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={startAuthenticator}
              disabled={starting}
            >
              <SmartphoneIcon />
              Use an authenticator app
            </Button>
          </div>

          <p className="text-sm text-muted-foreground">
            A passkey uses Face ID, Touch ID or your password manager — nothing
            to install. An authenticator app works anywhere, including on a
            shared computer.
          </p>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Not now
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AddPasskeyDialog
        optionsJSON={passkeyOptions}
        onOpenChange={(open) => !open && setPasskeyOptions(null)}
        onRegistered={handleEnrolled}
      />
      <EnrollMfaDialog
        otpauthUrl={enrollment?.otpauthUrl ?? null}
        onOpenChange={(open) => !open && setEnrollment(null)}
        onConfirmed={handleEnrolled}
      />
    </>
  );
}
