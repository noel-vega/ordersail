import { useState } from "react";
import { ApiError, type MfaEnrollResponse, type Passkey } from "merchant-sdk";
import { ShieldCheckIcon, InfoIcon, KeyRoundIcon } from "lucide-react";
import { Button } from "ui/button";
import { Alert, AlertDescription, AlertTitle } from "ui/alert";
import { useAuthMe } from "../../auth/permissions.hooks";
import { useEnrollMfaMutation } from "../mfa.hooks";
import { EnrollMfaDialog } from "../components/enroll-mfa-dialog";
import { DisableMfaDialog } from "../components/disable-mfa-dialog";
import { RegenerateCodesDialog } from "../components/regenerate-codes-dialog";
import {
  usePasskeys,
  getPasskeysQueryOptions,
} from "../../passkeys/passkeys.hooks";
import { browserSupportsWebAuthn } from "../../passkeys/webauthn";
import { AddPasskeyDialog } from "../../passkeys/components/add-passkey-dialog";
import { PasskeyList } from "../../passkeys/components/passkey-list";
import { RemovePasskeyDialog } from "../../passkeys/components/remove-passkey-dialog";
import { RenamePasskeyDialog } from "../../passkeys/components/rename-passkey-dialog";
import { merchantApi } from "../../../lib/merchant-api-client";
import { queryClient } from "../../../lib/react-query-client";

export function SecurityView(props: { required?: boolean }) {
  const me = useAuthMe();
  const passkeys = usePasskeys();
  const enroll = useEnrollMfaMutation();

  const [enrollment, setEnrollment] = useState<MfaEnrollResponse | null>(null);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);

  const [addOptions, setAddOptions] = useState<Record<string, unknown> | null>(
    null,
  );
  const [addError, setAddError] = useState<string | null>(null);
  const [addPending, setAddPending] = useState(false);
  const [renaming, setRenaming] = useState<Passkey | null>(null);
  const [removing, setRemoving] = useState<Passkey | null>(null);

  const totpEnabled = me.data?.totpEnabled ?? false;
  const hasMfaFactor = me.data?.hasMfaFactor ?? false;
  const supportsPasskeys = browserSupportsWebAuthn();

  // What the app gate in routes/app/route.tsx actually redirects on. It is
  // NOT the same as hasMfaFactor: until sign-in can challenge on a passkey
  // (OS-489), a passkey doesn't clear an account-wide MFA requirement, so a
  // user can hold a factor and still be blocked. Keying this page's
  // instructions off the wrong one told them to add a passkey and then
  // bounced them straight back here.
  const blockedByRequirement =
    props.required && !(me.data?.mfaEnrollmentSatisfied ?? true);

  // The options call happens here rather than inside the dialog, mirroring
  // how enrollMfa() is called before EnrollMfaDialog opens: the dialog's
  // open state is then derived from having options, so the two can't drift.
  async function handleAddPasskey() {
    setAddError(null);
    setAddPending(true);
    try {
      const options = await merchantApi.passkeys.registerOptions();
      setAddOptions(options as Record<string, unknown>);
    } catch (err) {
      setAddError(
        err instanceof ApiError
          ? err.message
          : "Couldn't start — try again.",
      );
    } finally {
      setAddPending(false);
    }
  }

  async function handleEnable() {
    setEnrollError(null);
    try {
      const result = await enroll.mutateAsync();
      if (result) setEnrollment(result);
    } catch (err) {
      setEnrollError(
        err instanceof ApiError
          ? err.message
          : "Couldn't start enrollment — try again.",
      );
    }
  }

  return (
    <div className="max-w-lg space-y-4">
      <h1 className="text-xl font-semibold">Security</h1>

      {blockedByRequirement && (
        <Alert>
          <InfoIcon />
          <AlertTitle>Your account requires a second factor</AlertTitle>
          <AlertDescription>
            Set up an authenticator app below to continue. Passkeys don&apos;t
            satisfy this requirement yet — you can still add one, but it
            won&apos;t unblock you.
          </AlertDescription>
        </Alert>
      )}

      {/* Passkeys first, and the primary action: no app to install, and
          phishing-resistant in a way a typed code isn't. */}
      <div className="space-y-4 rounded-lg border p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium">Passkeys</h2>
            <p className="text-sm text-muted-foreground">
              Confirm with Face ID, Touch ID, Windows Hello or your password
              manager. Nothing to install.
            </p>
          </div>
          {(passkeys.data?.length ?? 0) > 0 && (
            <ShieldCheckIcon className="size-5 shrink-0 text-primary" />
          )}
        </div>

        {blockedByRequirement && (
          <p className="text-sm text-muted-foreground">
            Adding a passkey here won&apos;t lift your account&apos;s
            requirement yet — set up an authenticator app below for that.
          </p>
        )}

        {/* A failed load must not be drawn as "you have none". This is a
            security inventory: reading it as empty invites adding a
            duplicate, or believing an old credential was already removed.
            Query failures are silent here — the global toast is on the
            mutation cache, not this one. */}
        {passkeys.isError ? (
          <div className="flex flex-col items-center gap-2 rounded-md border border-dashed p-6 text-center">
            <p className="text-sm font-medium">Couldn&apos;t load your passkeys</p>
            <p className="text-sm text-muted-foreground">
              This list may be incomplete — try again before adding one.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void passkeys.refetch()}
              disabled={passkeys.isFetching}
            >
              {passkeys.isFetching ? "Retrying..." : "Retry"}
            </Button>
          </div>
        ) : passkeys.data && passkeys.data.length > 0 ? (
          <PasskeyList
            passkeys={passkeys.data}
            onRename={setRenaming}
            onRemove={setRemoving}
          />
        ) : (
          // packages/ui has no empty-state primitive — same hand-rolled
          // block the products list uses
          !passkeys.isPending && (
            <div className="flex flex-col items-center gap-1 rounded-md border border-dashed p-6 text-center">
              <KeyRoundIcon className="size-5 text-muted-foreground" />
              <p className="text-sm font-medium">No passkeys yet</p>
              <p className="text-sm text-muted-foreground">
                Add one for faster sign-in.
              </p>
            </div>
          )
        )}

        {addError && <p className="text-sm text-destructive">{addError}</p>}

        {supportsPasskeys ? (
          <Button
            variant={blockedByRequirement ? "outline" : "default"}
            onClick={handleAddPasskey}
            disabled={addPending}
          >
            {addPending ? "Starting..." : "Add a passkey"}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            This browser can&apos;t use passkeys. Use an authenticator app
            below, or try a different browser.
          </p>
        )}
      </div>

      {/* Still offered, plainly, and not hidden behind a disclosure: shared
          back-office machines and browsers without WebAuthn need it. */}
      <div className="space-y-4 rounded-lg border p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium">Authenticator app</h2>
            <p className="text-sm text-muted-foreground">
              {totpEnabled
                ? "Enabled — you'll be asked for a code when signing in."
                : "Use a 6-digit code from an app like Google Authenticator or 1Password."}
            </p>
          </div>
          {totpEnabled && (
            <ShieldCheckIcon className="size-5 shrink-0 text-muted-foreground" />
          )}
        </div>

        {enrollError && (
          <p className="text-sm text-destructive">{enrollError}</p>
        )}

        {totpEnabled ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" onClick={() => setDisableOpen(true)}>
              Disable
            </Button>
          </div>
        ) : (
          <Button
            variant={blockedByRequirement ? "default" : "outline"}
            onClick={handleEnable}
            disabled={enroll.isPending}
          >
            {enroll.isPending ? "Starting..." : "Set up an authenticator app"}
          </Button>
        )}
      </div>

      {/* Recovery codes belong to the user, not to a factor — a passkey-only
          user has them too, and for them they're the whole recovery story. */}
      {hasMfaFactor && (
        <div className="space-y-4 rounded-lg border p-4">
          <div>
            <h2 className="text-sm font-medium">Recovery codes</h2>
            <p className="text-sm text-muted-foreground">
              One-time codes for signing in if you lose your passkey or your
              authenticator app. Regenerating replaces any you still have.
            </p>
          </div>
          <Button variant="outline" onClick={() => setRegenerateOpen(true)}>
            Regenerate recovery codes
          </Button>
        </div>
      )}

      <AddPasskeyDialog
        optionsJSON={addOptions}
        onOpenChange={(open) => !open && setAddOptions(null)}
        onRegistered={() =>
          void queryClient.invalidateQueries(getPasskeysQueryOptions())
        }
      />
      <RenamePasskeyDialog
        passkey={renaming}
        onOpenChange={(open) => !open && setRenaming(null)}
      />
      <RemovePasskeyDialog
        passkey={removing}
        onOpenChange={(open) => !open && setRemoving(null)}
      />
      <EnrollMfaDialog
        otpauthUrl={enrollment?.otpauthUrl ?? null}
        onOpenChange={(open) => !open && setEnrollment(null)}
      />
      <DisableMfaDialog open={disableOpen} onOpenChange={setDisableOpen} />
      <RegenerateCodesDialog
        open={regenerateOpen}
        onOpenChange={setRegenerateOpen}
      />
    </div>
  );
}
