import type { OrderDetail } from "merchant-sdk";
import { Badge } from "ui/badge";

type OrderStatus = OrderDetail["status"];

type BadgeVariant = "outline" | "secondary" | "destructive";

const STATUS: Record<
  OrderStatus,
  { label: string; variant?: BadgeVariant; className?: string }
> = {
  pending: { label: "Pending", variant: "outline" },
  paid: { label: "Paid", variant: "secondary" },
  partially_refunded: {
    label: "Partially refunded",
    className:
      "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400",
  },
  refunded: {
    label: "Refunded",
    className:
      "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400",
  },
  canceled: {
    label: "Canceled",
    variant: "outline",
    className: "text-muted-foreground",
  },
  payment_failed: { label: "Payment failed", variant: "destructive" },
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const s = STATUS[status];
  return (
    <Badge variant={s.variant} className={s.className}>
      {s.label}
    </Badge>
  );
}
