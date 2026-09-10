import { useState } from "react";
import type { OrderDetail } from "merchant-sdk";
import { ApiError } from "merchant-sdk";
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
import { Field, FieldLabel } from "ui/field";
import { Input } from "ui/input";
import { formatCents } from "../../../lib/currency";
import { useCancelOrderMutation } from "../orders.hooks";

// net still collected on the order = tenders minus refunds already recorded.
// cancel.service only issues a refund for web orders paid by card; for a POS
// cash sale this is still positive but no money moves — so also gate on channel.
function refundPreviewCents(order: OrderDetail) {
  if (order.channel !== "web") return 0;
  const net = order.payments.reduce((n, p) => n + p.amountCents, 0);
  return net > 0 ? net : 0;
}

// units that go back to stock on cancel: everything ordered that a line-item
// refund hasn't already returned (the order is unfulfilled, so nothing shipped)
function restockUnits(order: OrderDetail) {
  return order.items.reduce(
    (n, i) => n + Math.max(0, i.quantity - i.refundedQuantity),
    0,
  );
}

export function CancelOrderDialog(props: {
  order: OrderDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { order } = props;
  const cancel = useCancelOrderMutation(order.id);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refundCents = refundPreviewCents(order);
  const units = restockUnits(order);
  const customer = order.customerName ?? "the customer";

  function close() {
    setReason("");
    setError(null);
    props.onOpenChange(false);
  }

  async function handleConfirm() {
    setError(null);
    try {
      await cancel.mutateAsync({ reason: reason.trim() || undefined });
      close();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Couldn't cancel this order — try again.",
      );
    }
  }

  return (
    <AlertDialog
      open={props.open}
      onOpenChange={(open) => !open && close()}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel order #{order.id}?</AlertDialogTitle>
          <AlertDialogDescription>
            {refundCents > 0
              ? `This refunds ${customer} ${formatCents(refundCents)} in full and returns ${units} ${units === 1 ? "item" : "items"} to stock. This can't be undone.`
              : `This returns ${units} ${units === 1 ? "item" : "items"} to stock and marks the order canceled. This can't be undone.`}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <Field>
          <FieldLabel>Reason (optional)</FieldLabel>
          <Input
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
            placeholder="e.g. customer changed their mind"
          />
        </Field>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <AlertDialogFooter>
          <AlertDialogCancel>Keep order</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={cancel.isPending}
            onClick={handleConfirm}
          >
            {cancel.isPending ? "Canceling..." : "Cancel order"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
