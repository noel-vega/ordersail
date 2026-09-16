import { useState } from "react";
import { ApiError, type MfaEnrollResponse } from "merchant-sdk";
import { ShieldCheckIcon } from "lucide-react";
import { Button } from "ui/button";
import { useAuthMe } from "../../auth/permissions.hooks";
import { useEnrollMfaMutation } from "../mfa.hooks";
import { EnrollMfaDialog } from "../components/enroll-mfa-dialog";
import { DisableMfaDialog } from "../components/disable-mfa-dialog";
import { RegenerateCodesDialog } from "../components/regenerate-codes-dialog";

export function SecurityView() {
  const me = useAuthMe();
  const enroll = useEnrollMfaMutation();
  const [enrollment, setEnrollment] = useState<MfaEnrollResponse | null>(null);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);

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

  const mfaEnabled = me.data?.mfaEnabled ?? false;

  return (
    <div className="max-w-lg space-y-4">
      <h1 className="text-xl font-semibold">Security</h1>

      <div className="space-y-4 rounded-lg border p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium">Two-factor authentication</h2>
            <p className="text-sm text-muted-foreground">
              {mfaEnabled
                ? "Enabled — you'll be asked for a code when signing in."
                : "Add a second step to sign-in using an authenticator app."}
            </p>
          </div>
          {mfaEnabled && (
            <ShieldCheckIcon className="size-5 shrink-0 text-primary" />
          )}
        </div>

        {enrollError && <p className="text-sm text-destructive">{enrollError}</p>}

        {mfaEnabled ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setRegenerateOpen(true)}>
              Regenerate recovery codes
            </Button>
            <Button variant="destructive" onClick={() => setDisableOpen(true)}>
              Disable
            </Button>
          </div>
        ) : (
          <Button onClick={handleEnable} disabled={enroll.isPending}>
            {enroll.isPending
              ? "Starting..."
              : "Enable two-factor authentication"}
          </Button>
        )}
      </div>

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
