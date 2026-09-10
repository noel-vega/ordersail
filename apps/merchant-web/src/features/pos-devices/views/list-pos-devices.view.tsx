import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { type ColumnDef } from "@tanstack/react-table";
import type { PosDevice, PosDevicePairing } from "merchant-sdk";
import { format } from "date-fns";
import {
  KeyRoundIcon,
  MoreVerticalIcon,
  PencilIcon,
  PlusIcon,
  XCircleIcon,
} from "lucide-react";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
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
import { Sheet, SheetContent } from "ui/sheet";
import { DataTable } from "../../../components/data-table";
import {
  getListPosDevicesQueryOptions,
  useRevokePosDeviceMutation,
  useRotatePairingMutation,
} from "../pos-devices.hooks";
import { MintDeviceSheet } from "./mint-device-sheet";
import { EditDeviceSheet } from "./edit-device-sheet";
import { PairingCodeReveal } from "../components/pairing-code-reveal";
import { Can } from "../../../components/can";
import { usePermissions } from "../../auth/permission-context";

const STATUS_BADGE: Record<
  PosDevice["status"],
  { label: string; variant: "default" | "secondary" | "outline" }
> = {
  pending: { label: "Pending", variant: "secondary" },
  active: { label: "Active", variant: "default" },
  revoked: { label: "Revoked", variant: "outline" },
};

function getColumns(handlers: {
  onEdit: (device: PosDevice) => void;
  onRevoke: (device: PosDevice) => void;
  onShowCode: (device: PosDevice) => void;
  canWrite: boolean;
}): ColumnDef<PosDevice>[] {
  return [
    { accessorKey: "name", header: "Name" },
    {
      id: "location",
      header: "Location",
      cell: ({ row }) => row.original.locationName ?? "—",
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => {
        const badge = STATUS_BADGE[row.original.status];
        return <Badge variant={badge.variant}>{badge.label}</Badge>;
      },
    },
    {
      accessorKey: "lastSeenAt",
      header: "Last seen",
      cell: ({ row }) =>
        row.original.lastSeenAt
          ? format(new Date(row.original.lastSeenAt), "MM/dd/yyyy hh:mm a")
          : "Never",
    },
    {
      accessorKey: "pairedAt",
      header: "Paired",
      cell: ({ row }) =>
        row.original.pairedAt
          ? format(new Date(row.original.pairedAt), "MM/dd/yyyy hh:mm a")
          : "—",
    },
    {
      id: "actions",
      cell: ({ row }) => {
        const device = row.original;
        if (device.status === "revoked" || !handlers.canWrite) return null;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Device actions"
                />
              }
            >
              <MoreVerticalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {device.status === "pending" && (
                <DropdownMenuItem onClick={() => handlers.onShowCode(device)}>
                  <KeyRoundIcon /> Show pairing code
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => handlers.onEdit(device)}>
                <PencilIcon /> Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => handlers.onRevoke(device)}
              >
                <XCircleIcon /> Revoke
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];
}

export function ListPosDevicesView() {
  const devices = useQuery(getListPosDevicesQueryOptions());
  const revoke = useRevokePosDeviceMutation();
  const rotate = useRotatePairingMutation();
  const canWrite = usePermissions().has("pos_devices:write");

  const [mintOpen, setMintOpen] = useState(false);
  const [editing, setEditing] = useState<PosDevice | null>(null);
  const [revoking, setRevoking] = useState<PosDevice | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revealing, setRevealing] = useState<{
    pairing: PosDevicePairing;
    locationName: string | null;
  } | null>(null);
  const [showCodeError, setShowCodeError] = useState<string | null>(null);

  async function handleShowCode(device: PosDevice) {
    setShowCodeError(null);
    try {
      const pairing = await rotate.mutateAsync(device.id);
      if (!pairing) {
        setShowCodeError("Couldn't generate a pairing code.");
        return;
      }
      setRevealing({ pairing, locationName: device.locationName });
    } catch {
      setShowCodeError("Couldn't generate a pairing code.");
    }
  }

  async function handleRevoke() {
    if (!revoking) return;
    setRevokeError(null);
    try {
      const result = await revoke.mutateAsync(revoking.id);
      if (!result) {
        setRevokeError("Couldn't revoke this device — try again.");
        return;
      }
      setRevoking(null);
    } catch {
      setRevokeError("Couldn't revoke this device — try again.");
    }
  }

  const columns = getColumns({
    onEdit: setEditing,
    onRevoke: (device) => {
      setRevokeError(null);
      setRevoking(device);
    },
    onShowCode: handleShowCode,
    canWrite,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">POS Devices</h1>
          <p className="text-sm text-muted-foreground">
            Tablets and phones running the POS app, each paired to one location.
          </p>
        </div>
        <Can permission="pos_devices:write">
          <Button onClick={() => setMintOpen(true)}>
            <PlusIcon /> New device
          </Button>
        </Can>
      </div>

      {showCodeError && (
        <p className="text-sm text-destructive">{showCodeError}</p>
      )}

      <DataTable data={devices.data ?? []} columns={columns} />

      <MintDeviceSheet open={mintOpen} onOpenChange={setMintOpen} />

      <EditDeviceSheet
        device={editing}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
      />

      <Sheet
        open={revealing !== null}
        onOpenChange={(open) => !open && setRevealing(null)}
      >
        <SheetContent className="flex flex-col">
          {revealing && (
            <PairingCodeReveal
              pairing={revealing.pairing}
              locationName={revealing.locationName}
              onDone={() => setRevealing(null)}
            />
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke "{revoking?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              The device signs out immediately and staff will need a new pairing
              code to use it again. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {revokeError && (
            <p className="text-sm text-destructive">{revokeError}</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={revoke.isPending}
              onClick={handleRevoke}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
