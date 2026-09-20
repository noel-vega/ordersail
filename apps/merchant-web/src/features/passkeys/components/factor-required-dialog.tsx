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
import {
  FactorSetupDialogs,
  FactorSetupOptions,
  useFactorSetup,
} from "./factor-setup";

// The factor-setup flow as a prompt, reached from every gated action.
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
  const setup = useFactorSetup({
    // Each nested flow CLOSES this dialog rather than opening on top of it —
    // two stacked modals means two focus traps and two scroll locks fighting
    // each other. Cancelling a nested flow drops the user back on the page
    // rather than back here; they can trigger the action again, which is a
    // cheaper trade than managing a reopen.
    onStarted: () => props.onOpenChange(false),
    onEnrolled: () => {
      props.onOpenChange(false);
      props.onReady();
    },
  });

  // Without this a failed registerOptions() leaves its message behind, and
  // the next gated action reopens the dialog already showing a stale failure
  // the user hasn't caused yet.
  function handleOpenChange(next: boolean) {
    if (!next) {
      props.onOpenChange(false);
      setTimeout(setup.clearError, 200);
    }
  }

  return (
    <>
      <Dialog open={props.open} onOpenChange={handleOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a second factor first</DialogTitle>
            <DialogDescription>
              Before you {props.action}, secure your account with a passkey or
              an authenticator app. It takes a few seconds, and you&apos;ll come
              straight back here.
            </DialogDescription>
          </DialogHeader>

          <FactorSetupOptions setup={setup} />

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Not now
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <FactorSetupDialogs setup={setup} />
    </>
  );
}
