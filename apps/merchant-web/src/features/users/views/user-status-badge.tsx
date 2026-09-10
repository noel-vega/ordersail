import type { User } from "merchant-sdk";
import { Badge } from "ui/badge";

const LABELS: Record<User["status"], string> = {
  active: "Active",
  invited: "Pending",
  deactivated: "Deactivated",
};

const VARIANTS: Record<
  User["status"],
  "default" | "secondary" | "outline"
> = {
  active: "default",
  invited: "secondary",
  deactivated: "outline",
};

export function UserStatusBadge({ status }: { status: User["status"] }) {
  return <Badge variant={VARIANTS[status]}>{LABELS[status]}</Badge>;
}
