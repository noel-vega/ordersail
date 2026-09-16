import { CopyIcon } from "lucide-react";
import { Button } from "ui/button";
import { toast } from "ui/sonner";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "ui/dialog";

// shown exactly once, right after confirm/regenerate — the API never
// returns these again after this response
export function RecoveryCodesReveal(props: {
  codes: string[];
  onDone: () => void;
}) {
  async function copyAll() {
    try {
      await navigator.clipboard.writeText(props.codes.join("\n"));
      toast.success("Recovery codes copied");
    } catch {
      // clipboard can be unavailable (insecure context / denied permission)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Save your recovery codes</DialogTitle>
        <DialogDescription>
          Each code works once, if you ever lose access to your authenticator
          app. Store them somewhere safe — they won&apos;t be shown again.
        </DialogDescription>
      </DialogHeader>

      <div className="grid grid-cols-2 gap-2 rounded-md border p-4 font-mono text-sm">
        {props.codes.map((code) => (
          <span key={code}>{code}</span>
        ))}
      </div>

      <Button type="button" variant="outline" onClick={copyAll}>
        <CopyIcon /> Copy all codes
      </Button>

      <DialogFooter>
        <Button onClick={props.onDone}>I&apos;ve saved these codes</Button>
      </DialogFooter>
    </>
  );
}
