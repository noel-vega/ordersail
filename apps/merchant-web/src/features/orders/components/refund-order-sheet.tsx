import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import type { OrderDetail } from "merchant-sdk";
import { ApiError } from "merchant-sdk";
import { LoaderCircleIcon, MinusIcon, PlusIcon } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "ui/sheet";
import { Field, FieldLabel, FieldDescription } from "ui/field";
import { Input } from "ui/input";
import { Textarea } from "ui/textarea";
import { Button } from "ui/button";
import { cn } from "ui/utils";
import { formatCents } from "../../../lib/currency";
import { useRefundOrderMutation } from "../orders.hooks";

type Mode = "full" | "amount" | "items";
type OrderItem = OrderDetail["items"][number];

// net still collected on the order = tenders minus the refunds already recorded
function refundableCents(order: OrderDetail) {
  return order.payments.reduce((n, p) => n + p.amountCents, 0);
}

function lineRemaining(item: OrderItem) {
  return item.quantity - item.refundedQuantity;
}

export function RefundOrderSheet(props: {
  order: OrderDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Refund order #{props.order.id}</SheetTitle>
          <SheetDescription>
            {formatCents(refundableCents(props.order))} still refundable
          </SheetDescription>
        </SheetHeader>
        {props.open && (
          <RefundForm
            order={props.order}
            onDone={() => props.onOpenChange(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

interface FormValues {
  reason: string;
  restock: boolean;
  amountDollars: number;
}

// mounted only while the sheet is open, so it always starts from a clean draft
function RefundForm({
  order,
  onDone,
}: {
  order: OrderDetail;
  onDone: () => void;
}) {
  const refund = useRefundOrderMutation(order.id);
  const max = refundableCents(order);
  const [mode, setMode] = useState<Mode>("full");
  const [qtys, setQtys] = useState<Record<number, number>>({});
  const [error, setError] = useState<string | null>(null);
  const form = useForm<FormValues>({
    defaultValues: { reason: "", restock: true, amountDollars: max / 100 },
  });
  const amountDollars = form.watch("amountDollars");

  const previewCents =
    mode === "full"
      ? max
      : mode === "amount"
        ? Math.round((amountDollars || 0) * 100)
        : order.items.reduce((n, i) => n + (qtys[i.id] ?? 0) * i.priceCents, 0);

  const setQty = (id: number, q: number) =>
    setQtys((prev) => ({ ...prev, [id]: q }));

  const handleSubmit = form.handleSubmit(async (data) => {
    setError(null);
    const reason = data.reason.trim() || undefined;

    if (mode === "amount" && (previewCents < 1 || previewCents > max)) {
      setError(`Enter an amount between $0.01 and ${formatCents(max)}.`);
      return;
    }
    const lines = order.items
      .filter((i) => (qtys[i.id] ?? 0) > 0)
      .map((i) => ({ orderItemId: i.id, quantity: qtys[i.id] }));
    if (mode === "items" && lines.length === 0) {
      setError("Select at least one item to refund.");
      return;
    }

    const body =
      mode === "full"
        ? { reason, restock: data.restock }
        : mode === "amount"
          ? { amountCents: previewCents, reason, restock: false }
          : { lines, reason, restock: data.restock };

    try {
      await refund.mutateAsync(body);
      onDone();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Refund failed — try again.",
      );
    }
  });

  return (
    <form onSubmit={handleSubmit} className="flex flex-1 flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto px-4">
        <Field>
          <FieldLabel>What to refund</FieldLabel>
          <div className="grid grid-cols-3 gap-2">
            {(["full", "amount", "items"] as const).map((m) => (
              <Button
                key={m}
                type="button"
                variant="outline"
                className={cn(
                  mode === m && "border-primary bg-primary/5 text-primary",
                )}
                onClick={() => setMode(m)}
              >
                {m === "full" ? "Full" : m === "amount" ? "By amount" : "By items"}
              </Button>
            ))}
          </div>
        </Field>

        {mode === "amount" && (
          <Controller
            control={form.control}
            name="amountDollars"
            render={({ field }) => (
              <Field>
                <FieldLabel>Amount</FieldLabel>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={field.value}
                  onChange={(e) => field.onChange(e.currentTarget.valueAsNumber)}
                />
                <FieldDescription>Up to {formatCents(max)}</FieldDescription>
              </Field>
            )}
          />
        )}

        {mode === "items" && (
          <Field>
            <FieldLabel>Items</FieldLabel>
            <div className="space-y-2">
              {order.items.map((item) => {
                const remaining = lineRemaining(item);
                const q = qtys[item.id] ?? 0;
                return (
                  <div key={item.id} className="flex items-center gap-2 text-sm">
                    <div className="flex-1">
                      <div>{item.productName}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatCents(item.priceCents)} · {remaining} refundable
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      disabled={q <= 0}
                      onClick={() => setQty(item.id, q - 1)}
                      aria-label={`One fewer ${item.productName}`}
                    >
                      <MinusIcon />
                    </Button>
                    <span className="w-6 text-center tabular-nums">{q}</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      disabled={q >= remaining}
                      onClick={() => setQty(item.id, q + 1)}
                      aria-label={`One more ${item.productName}`}
                    >
                      <PlusIcon />
                    </Button>
                  </div>
                );
              })}
            </div>
          </Field>
        )}

        {mode !== "amount" && (
          <Controller
            control={form.control}
            name="restock"
            render={({ field }) => (
              <Field>
                <FieldLabel>Return items to stock</FieldLabel>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className={cn(
                      field.value && "border-primary bg-primary/5 text-primary",
                    )}
                    onClick={() => field.onChange(true)}
                  >
                    Yes
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className={cn(
                      !field.value && "border-primary bg-primary/5 text-primary",
                    )}
                    onClick={() => field.onChange(false)}
                  >
                    No
                  </Button>
                </div>
              </Field>
            )}
          />
        )}

        <Controller
          control={form.control}
          name="reason"
          render={({ field }) => (
            <Field>
              <FieldLabel>Reason (optional)</FieldLabel>
              <Textarea placeholder="e.g. damaged in transit" {...field} />
            </Field>
          )}
        />

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      <SheetFooter className="flex-row justify-end">
        <Button
          type="button"
          variant="outline"
          disabled={refund.isPending}
          onClick={onDone}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={refund.isPending || previewCents < 1}>
          {refund.isPending ? (
            <>
              <LoaderCircleIcon className="animate-spin" /> Refunding...
            </>
          ) : (
            `Refund ${formatCents(previewCents)}`
          )}
        </Button>
      </SheetFooter>
    </form>
  );
}
