import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "ui/alert-dialog";
import { toast } from "ui/sonner";
import { useRevokeOtherSessionsMutation } from "../sessions.hooks";

// An AlertDialog rather than DisableMfaDialog's password form: this is a
// confirm-only destructive action, like revoking an API key. There's no
// password field because the endpoint asks for none — signing sessions out
// only ever takes access away, so re-authenticating would guard nothing and
// would shut out a passkey-only user who has no password to type.
export function SignOutEverywhereDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const revoke = useRevokeOtherSessionsMutation();

  async function handleConfirm() {
    try {
      await revoke.mutateAsync();
      toast.success("Other sessions signed out");
      props.onOpenChange(false);
    } catch {
      // the global toast handler already reported it; leave the dialog open
      // so the action can be retried
    }
  }

  return (
    <AlertDialog
      open={props.open}
      onOpenChange={(open) => !open && props.onOpenChange(false)}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Sign out everywhere else?</AlertDialogTitle>
          <AlertDialogDescription>
            Every other browser and device signed in as you is signed out.
            You&apos;ll stay signed in here. Anyone signed in elsewhere will
            need your password again — including you, on your other devices.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={revoke.isPending}
            onClick={handleConfirm}
          >
            {revoke.isPending ? "Signing out..." : "Sign out everywhere"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
