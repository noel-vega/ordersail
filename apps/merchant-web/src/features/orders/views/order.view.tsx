import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { format, formatDistanceToNow } from "date-fns";
import type { ColumnDef } from "@tanstack/react-table";
import type { OrderDetail, ShippingRate } from "merchant-sdk";
import {
  ArrowLeftIcon,
  BanIcon,
  LoaderCircleIcon,
  MoreVerticalIcon,
  TruckIcon,
} from "lucide-react";
import { Button } from "ui/button";
import { Badge } from "ui/badge";
import { Separator } from "ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
import { cn } from "ui/utils";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "ui/select";
import { Input } from "ui/input";
import { DataTable } from "../../../components/data-table";
import { useOrderQuery } from "../orders.hooks";
import {
  useCreateFulfillmentMutation,
  useGetFulfillmentRatesMutation,
} from "../../fulfillments/fulfillments.hooks";
import { useListLocationsQuery } from "../../locations/locations.hooks";
import { formatCents } from "../../../lib/currency";
import { FulfillmentStatusBadge } from "../components/fulfillment-status-badge";
import { OrderStatusBadge } from "../components/order-status-badge";
import { OrderEventIcon } from "../components/order-event-icon";
import { RefundOrderSheet } from "../components/refund-order-sheet";
import { CancelOrderDialog } from "../components/cancel-order-dialog";

type OrderItem = OrderDetail["items"][number];
type OrderFulfillment = OrderDetail["fulfillments"][number];

const PAYMENT_METHOD_LABEL: Record<OrderDetail["payments"][number]["method"], string> = {
  stripe: "Card (online)",
  card: "Card",
  cash: "Cash",
};

const columns: ColumnDef<OrderItem>[] = [
  {
    accessorKey: "productName",
    header: "Product",
    cell: ({ row }) => {
      const item = row.original;
      return (
        <div>
          <div>{item.productName}</div>
          {item.optionsLabel && (
            <div className="text-xs text-muted-foreground">{item.optionsLabel}</div>
          )}
        </div>
      );
    },
  },
  {
    accessorKey: "sku",
    header: "SKU",
    cell: ({ row }) => row.original.sku ?? "—",
  },
  {
    accessorKey: "priceCents",
    header: "Price",
    cell: ({ row }) => formatCents(row.original.priceCents),
  },
  {
    accessorKey: "quantity",
    header: "Qty",
  },
  {
    id: "lineTotal",
    header: "Total",
    cell: ({ row }) =>
      formatCents(row.original.priceCents * row.original.quantity),
  },
];

function ExistingFulfillments({ order }: { order: OrderDetail }) {
  if (order.fulfillments.length === 0) return null;

  return (
    <div className="space-y-3">
      {order.fulfillments.map((fulfillment: OrderFulfillment) => (
        <div key={fulfillment.id} className="rounded-lg border p-3">
          <p className="text-sm font-medium">
            {fulfillment.shippingCarrier} {fulfillment.shippingServiceLevel}
            <span className="text-muted-foreground font-normal">
              {" "}
              · from {fulfillment.locationName}
            </span>
          </p>
          {fulfillment.trackingNumber && (
            <p className="text-sm text-muted-foreground">
              Tracking:{" "}
              {fulfillment.trackingUrl ? (
                <a
                  href={fulfillment.trackingUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-foreground"
                >
                  {fulfillment.trackingNumber}
                </a>
              ) : (
                fulfillment.trackingNumber
              )}
            </p>
          )}
          <ul className="text-sm text-muted-foreground mt-1 list-disc list-inside">
            {fulfillment.items.map((fi) => {
              const item = order.items.find((i) => i.id === fi.orderItemId);
              return (
                <li key={fi.orderItemId}>
                  {fi.quantity} × {item?.productName ?? `Item #${fi.orderItemId}`}
                </li>
              );
            })}
          </ul>
          {fulfillment.labelUrl && (
            <a href={fulfillment.labelUrl} target="_blank" rel="noreferrer">
              <Button type="button" variant="outline" size="sm" className="mt-2">
                Download label
              </Button>
            </a>
          )}
        </div>
      ))}
    </div>
  );
}

// how much of `item` to default to shipping from `locationId` — capped at
// both what's still unfulfilled overall and what was actually allocated to
// that location, but the latter isn't enforced past this default (see
// FulfillmentsService.resolveRequest on the backend)
function defaultQuantity(item: OrderItem, locationId: number): number {
  const allocation = item.allocations.find((a) => a.locationId === locationId);
  return Math.min(item.remainingQuantity, allocation?.quantity ?? item.remainingQuantity);
}

function CreateFulfillmentFlow({ order }: { order: OrderDetail }) {
  const fulfillableItems = order.items.filter((item) => item.remainingQuantity > 0);
  const { data: locations } = useListLocationsQuery();

  // orders placed before allocation tracking existed have no allocation
  // data on any item — fall back to every addressed account location
  // rather than leaving the order unfulfillable through the UI. Orders
  // that do have allocation data keep the tighter, allocation-scoped list.
  const hasAllocationData = fulfillableItems.some((item) => item.allocations.length > 0);
  const locationOptions = hasAllocationData
    ? fulfillableItems
        .flatMap((item) => item.allocations)
        .reduce<{ id: number; name: string }[]>((options, allocation) => {
          if (!options.some((o) => o.id === allocation.locationId)) {
            options.push({ id: allocation.locationId, name: allocation.locationName });
          }
          return options;
        }, [])
    : (locations ?? [])
        .filter((location) => location.addressLine1)
        .map((location) => ({ id: location.id, name: location.name }));

  // null until the merchant picks one — the effective locationId below
  // falls back to the first option, computed at render time rather than as
  // this state's initial value, so it stays correct once locationOptions
  // updates (e.g. once useListLocationsQuery resolves) instead of freezing
  // on whatever was available on the very first render
  const [selectedLocationId, setSelectedLocationId] = useState<number | null>(null);
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [rates, setRates] = useState<ShippingRate[] | null>(null);
  const [selectedRate, setSelectedRate] = useState<ShippingRate | null>(null);

  const getRates = useGetFulfillmentRatesMutation();
  const createFulfillment = useCreateFulfillmentMutation(order.id);

  if (fulfillableItems.length === 0) return null;

  const locationId = selectedLocationId ?? locationOptions[0]?.id ?? null;

  if (locationOptions.length === 0 || locationId === null) {
    return (
      <div>
        <h2 className="font-medium mb-1">Create a fulfillment</h2>
        <p className="text-sm text-muted-foreground">
          No source location is recorded for the remaining items on this order yet.
        </p>
      </div>
    );
  }

  // items with no allocation data at all show up under every location
  // (nothing to scope by); items that do have allocation data stay scoped
  // to the location(s) they were actually pulled from
  const itemsForLocation = fulfillableItems.filter(
    (item) =>
      item.allocations.length === 0 || item.allocations.some((a) => a.locationId === locationId),
  );
  const requestItems = itemsForLocation
    .map((item) => ({
      orderItemId: item.id,
      quantity: quantities[item.id] ?? defaultQuantity(item, locationId),
    }))
    .filter((i) => i.quantity > 0);

  const resetQuoting = () => {
    setRates(null);
    setSelectedRate(null);
  };

  return (
    <div>
      <h2 className="font-medium mb-2">Create a fulfillment</h2>

      <div className="max-w-sm space-y-1 mb-3">
        <Select
          value={String(locationId)}
          onValueChange={(value) => {
            setSelectedLocationId(Number(value));
            setQuantities({});
            resetQuoting();
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder="Ship from…" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {locationOptions.map((location) => (
                <SelectItem key={location.id} value={String(location.id)}>
                  {location.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <div className="max-w-sm space-y-2 mb-3">
        {itemsForLocation.map((item) => {
          const quantity = quantities[item.id] ?? defaultQuantity(item, locationId);
          return (
            <div key={item.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="flex-1">
                {item.productName}
                <span className="text-muted-foreground">
                  {" "}
                  ({item.remainingQuantity} remaining)
                </span>
              </span>
              <Input
                type="number"
                min={0}
                max={item.remainingQuantity}
                value={quantity}
                className="w-20"
                onChange={(e) => {
                  const next = Math.max(
                    0,
                    Math.min(item.remainingQuantity, Number(e.target.value) || 0),
                  );
                  setQuantities((q) => ({ ...q, [item.id]: next }));
                  resetQuoting();
                }}
              />
            </div>
          );
        })}
      </div>

      {!rates && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={requestItems.length === 0 || getRates.isPending}
          onClick={() =>
            getRates.mutate(
              { orderId: order.id, locationId, items: requestItems },
              { onSuccess: (data) => setRates(data ?? []) },
            )
          }
        >
          {getRates.isPending ? (
            <>
              <LoaderCircleIcon className="animate-spin" /> Getting rates...
            </>
          ) : (
            <>
              <TruckIcon /> Get shipping rates
            </>
          )}
        </Button>
      )}

      {getRates.isError && (
        <p className="text-sm text-destructive mt-1">
          Couldn't get shipping rates for this order.
        </p>
      )}

      {rates && rates.length === 0 && (
        <p className="text-sm text-muted-foreground">No rates available.</p>
      )}

      {rates && rates.length > 0 && (
        <div className="space-y-2 max-w-sm">
          {rates.map((rate) => (
            <button
              key={rate.objectId}
              type="button"
              onClick={() => setSelectedRate(rate)}
              className={cn(
                "flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm",
                selectedRate?.objectId === rate.objectId
                  ? "border-primary bg-primary/5"
                  : "hover:bg-muted",
              )}
            >
              <span>
                {rate.provider} {rate.servicelevel}
                {rate.estimatedDays && (
                  <span className="text-muted-foreground">
                    {" "}
                    · {rate.estimatedDays}d
                  </span>
                )}
              </span>
              <span className="font-medium">{formatCents(rate.amountCents)}</span>
            </button>
          ))}

          <Button
            type="button"
            disabled={!selectedRate || createFulfillment.isPending}
            onClick={() =>
              selectedRate &&
              createFulfillment.mutate(
                {
                  orderId: order.id,
                  locationId,
                  items: requestItems,
                  rateObjectId: selectedRate.objectId,
                  provider: selectedRate.provider,
                  servicelevel: selectedRate.servicelevel,
                  amountCents: selectedRate.amountCents,
                },
                {
                  onSuccess: () => {
                    setQuantities({});
                    resetQuoting();
                  },
                },
              )
            }
          >
            {createFulfillment.isPending ? (
              <>
                <LoaderCircleIcon className="animate-spin" /> Buying label...
              </>
            ) : (
              "Buy label"
            )}
          </Button>

          {createFulfillment.isError && (
            <p className="text-sm text-destructive">
              Couldn't purchase a label for that rate.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function OrderView({ id }: { id: number }) {
  const { data } = useOrderQuery(id);
  const [refundOpen, setRefundOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  if (!data) {
    return null;
  }

  const canRefund =
    (data.status === "paid" || data.status === "partially_refunded") &&
    data.payments.some((p) => p.method === "stripe" && p.amountCents > 0);

  // cancel is pre-fulfillment only, and pointless once the order is terminal
  const canCancel =
    data.fulfillmentStatus === "unfulfilled" &&
    data.status !== "canceled" &&
    data.status !== "refunded";

  return (
    <div>
      <header className="mb-8">
        <div className="flex items-start gap-3">
          <Link to="/app/orders">
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Back to orders">
              <ArrowLeftIcon />
            </Button>
          </Link>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold">Order #{data.id}</h1>
              <Badge variant="outline">
                {data.channel === "pos" ? "In-store" : "Online"}
              </Badge>
              <OrderStatusBadge status={data.status} />
              {data.shipping && (
                <FulfillmentStatusBadge status={data.fulfillmentStatus} />
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              Placed {format(new Date(data.createdAt), "MM/dd/yyyy hh:mm a")}
            </p>
          </div>
          {canCancel && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Order actions"
                  />
                }
              >
                <MoreVerticalIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setCancelOpen(true)}
                >
                  <BanIcon /> Cancel order
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-8 mb-8 text-sm">
        <div>
          <h2 className="font-medium mb-1">Customer</h2>
          {data.customerName || data.customerEmail ? (
            <>
              <p>{data.customerName ?? "—"}</p>
              <p className="text-muted-foreground">{data.customerEmail}</p>
            </>
          ) : (
            <p className="text-muted-foreground">Walk-in customer</p>
          )}
        </div>
        <div>
          <h2 className="font-medium mb-1">
            {data.shipping ? "Shipping address" : "Fulfillment"}
          </h2>
          {data.shipping ? (
            <>
              <p>{data.shipping.line1}</p>
              {data.shipping.line2 && <p>{data.shipping.line2}</p>}
              <p>
                {data.shipping.city}
                {data.shipping.state ? `, ${data.shipping.state}` : ""}{" "}
                {data.shipping.postalCode}
              </p>
              <p>{data.shipping.country}</p>
            </>
          ) : (
            <p className="text-muted-foreground">
              In-store sale — carried out, no shipping
            </p>
          )}
        </div>
      </div>

      <DataTable columns={columns} data={data.items} />

      <Separator className="my-4" />

      <div className="flex justify-end gap-8 text-sm">
        <span className="text-muted-foreground">Subtotal: {formatCents(data.subtotalCents)}</span>
        {data.shipping && (
          <span className="text-muted-foreground">
            Shipping: {formatCents(data.shippingCents)}
          </span>
        )}
        <span className="font-medium">Total: {formatCents(data.amountTotalCents)}</span>
      </div>

      {data.payments.length > 0 && (
        <>
          <Separator className="my-4" />
          <div className="text-sm">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="font-medium">Payment</h2>
              {canRefund && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setRefundOpen(true)}
                >
                  Refund
                </Button>
              )}
            </div>
            {data.payments.map((payment, i) =>
              payment.amountCents < 0 ? (
                <p key={i} className="text-muted-foreground">
                  Refund: {formatCents(payment.amountCents)}
                  {payment.reason && ` — ${payment.reason}`}
                </p>
              ) : (
                <p key={i} className="text-muted-foreground">
                  {PAYMENT_METHOD_LABEL[payment.method]}: {formatCents(payment.amountCents)}
                  {payment.amountTenderedCents != null &&
                    ` — tendered ${formatCents(payment.amountTenderedCents)}, change ${formatCents(
                      payment.amountTenderedCents - payment.amountCents,
                    )}`}
                </p>
              ),
            )}
          </div>
        </>
      )}

      {data.events.length > 0 && (
        <>
          <Separator className="my-4" />
          <div className="text-sm">
            <h2 className="font-medium mb-2">Activity</h2>
            <ul className="space-y-3">
              {data.events.map((event) => (
                <li key={event.id} className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground [&>svg]:size-3.5">
                    <OrderEventIcon type={event.type} />
                  </span>
                  <div>
                    <p>{event.message}</p>
                    <p className="text-xs text-muted-foreground">
                      {event.actorName ??
                        (event.actorType === "system" ? "System" : "Staff")}{" "}
                      · {formatDistanceToNow(new Date(event.createdAt), { addSuffix: true })}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {data.shipping && (
        <>
          <Separator className="my-4" />
          <div className="space-y-6">
            <ExistingFulfillments order={data} />
            <CreateFulfillmentFlow order={data} />
          </div>
        </>
      )}

      <RefundOrderSheet
        order={data}
        open={refundOpen}
        onOpenChange={setRefundOpen}
      />

      <CancelOrderDialog
        order={data}
        open={cancelOpen}
        onOpenChange={setCancelOpen}
      />
    </div>
  );
}
