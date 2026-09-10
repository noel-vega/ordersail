import type { OrderEvent } from "merchant-sdk";
import {
  ArrowRightIcon,
  BanIcon,
  CreditCardIcon,
  InfoIcon,
  type LucideIcon,
  RotateCcwIcon,
  TruckIcon,
} from "lucide-react";

const ICON: Record<OrderEvent["type"], LucideIcon> = {
  status_changed: ArrowRightIcon,
  refund: RotateCcwIcon,
  cancellation: BanIcon,
  payment: CreditCardIcon,
  fulfillment: TruckIcon,
  note: InfoIcon,
};

export function OrderEventIcon({ type }: { type: OrderEvent["type"] }) {
  const Icon = ICON[type];
  return <Icon />;
}
