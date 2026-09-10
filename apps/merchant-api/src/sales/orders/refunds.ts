import { ConflictException } from '@nestjs/common';
import {
  and,
  type db as Db,
  eq,
  orderEventsTable,
  orderPaymentsTable,
  ordersTable,
  sql,
} from 'db/sales';
import { inventoryMovementsTable, inventoryTable } from 'db/stock';
import {
  canTransition,
  transitionOrderStatus,
  type OrderStatus,
} from './order-status';

type Executor = Pick<typeof Db, 'select' | 'update' | 'insert'>;

export interface RestockLine {
  orderItemId: number;
  variantId: number;
  locationId: number;
  quantity: number;
}

// Where a returned quantity of an order item should go back — reverses the
// checkout worker's `sold` movements for that item (which recorded which
// location(s) the stock was pulled from), largest source first. If asked to
// restock more than was ever sold (shouldn't happen behind the OS-122 caps),
// the remainder lands on the largest source location.
export async function resolveRestockTargets(
  executor: Executor,
  params: { orderItemId: number; quantity: number },
): Promise<RestockLine[]> {
  if (params.quantity <= 0) return [];

  const sources = await executor
    .select({
      variantId: inventoryMovementsTable.variantId,
      locationId: inventoryMovementsTable.locationId,
      sold: sql<number>`sum(-${inventoryMovementsTable.delta})::int`,
    })
    .from(inventoryMovementsTable)
    .where(
      and(
        eq(inventoryMovementsTable.orderItemId, params.orderItemId),
        eq(inventoryMovementsTable.reason, 'sold'),
      ),
    )
    .groupBy(
      inventoryMovementsTable.variantId,
      inventoryMovementsTable.locationId,
    )
    .orderBy(sql`sum(-${inventoryMovementsTable.delta}) desc`);

  if (sources.length === 0) return [];

  const lines: RestockLine[] = [];
  let remaining = params.quantity;
  for (const src of sources) {
    if (remaining <= 0) break;
    const take = Math.min(src.sold, remaining);
    if (take <= 0) continue;
    lines.push({
      orderItemId: params.orderItemId,
      variantId: src.variantId,
      locationId: src.locationId,
      quantity: take,
    });
    remaining -= take;
  }
  if (remaining > 0) {
    const top = sources[0];
    lines.push({
      orderItemId: params.orderItemId,
      variantId: top.variantId,
      locationId: top.locationId,
      quantity: remaining,
    });
  }
  return lines;
}

// Applies a set of restock lines — one `return` movement + a materialised
// balance bump per line. Shared by recordRefund (a refund's restock) and
// OS-125's cancel (its no-refund restock path).
export async function applyRestock(
  executor: Pick<typeof Db, 'insert'>,
  lines: RestockLine[],
): Promise<void> {
  for (const line of lines) {
    if (line.quantity <= 0) continue;
    await executor.insert(inventoryMovementsTable).values({
      orderItemId: line.orderItemId,
      variantId: line.variantId,
      locationId: line.locationId,
      delta: line.quantity,
      reason: 'return',
    });
    await executor
      .insert(inventoryTable)
      .values({
        variantId: line.variantId,
        locationId: line.locationId,
        stock: line.quantity,
      })
      .onConflictDoUpdate({
        target: [inventoryTable.variantId, inventoryTable.locationId],
        set: {
          stock: sql`${inventoryTable.stock} + ${line.quantity}`,
          updatedAt: new Date(),
        },
      });
  }
}

export interface RecordRefundInput {
  orderId: number;
  // the tender being reversed — its `method` is copied onto the refund row
  parentPaymentId: number;
  // positive; persisted as a negative order_payments row
  grossAmountCents: number;
  stripeRefundId: string;
  reason?: string | null;
  restockLines?: RestockLine[];
  actorType: 'staff' | 'system' | 'customer';
  actorUserId?: number | null;
  // per-line summary folded into the refund event's `data.lines`
  eventLines?: { orderItemId: number; quantity: number }[];
}

export interface RecordRefundResult {
  refundPaymentId: number;
  netCollectedCents: number;
  status: OrderStatus;
}

// The shared refund-persistence primitive — OS-121 (full) / OS-122 (partial)
// call it after Stripe confirms the refund; OS-127 calls it reconciling a
// dashboard-initiated refund. Runs entirely in the caller's transaction and
// writes: the negative order_payments row, the `return` inventory movements +
// balance bump, the order status move (through OS-119's rules), and the
// `refund` audit event.
export async function recordRefund(
  executor: Executor,
  input: RecordRefundInput,
): Promise<RecordRefundResult> {
  if (input.grossAmountCents <= 0) {
    throw new ConflictException('Refund amount must be positive');
  }

  const [parent] = await executor
    .select({ method: orderPaymentsTable.method })
    .from(orderPaymentsTable)
    .where(
      and(
        eq(orderPaymentsTable.id, input.parentPaymentId),
        eq(orderPaymentsTable.orderId, input.orderId),
      ),
    );
  if (!parent) {
    throw new ConflictException(
      `Payment ${input.parentPaymentId} not found on order ${input.orderId}`,
    );
  }

  const [refundRow] = await executor
    .insert(orderPaymentsTable)
    .values({
      orderId: input.orderId,
      method: parent.method,
      amountCents: -input.grossAmountCents,
      stripeRefundId: input.stripeRefundId,
      reason: input.reason ?? null,
      parentPaymentId: input.parentPaymentId,
    })
    .returning({ id: orderPaymentsTable.id });

  await applyRestock(executor, input.restockLines ?? []);

  const [{ net }] = await executor
    .select({
      net: sql<number>`coalesce(sum(${orderPaymentsTable.amountCents}), 0)::int`,
    })
    .from(orderPaymentsTable)
    .where(eq(orderPaymentsTable.orderId, input.orderId));

  const [order] = await executor
    .select({ status: ordersTable.status })
    .from(ordersTable)
    .where(eq(ordersTable.id, input.orderId));

  const target: OrderStatus = net <= 0 ? 'refunded' : 'partially_refunded';
  // Skip the move when it isn't reachable — e.g. a canceled order picking up a
  // late dashboard refund via OS-127. The negative row + event below still land
  // so the money is recorded; the status just stays canceled.
  if (order && order.status !== target && canTransition(order.status, target)) {
    await transitionOrderStatus(executor, {
      orderId: input.orderId,
      to: target,
      actorType: input.actorType,
      actorUserId: input.actorUserId,
      reason: input.reason,
    });
  }

  await executor.insert(orderEventsTable).values({
    orderId: input.orderId,
    type: 'refund',
    data: {
      grossAmountCents: input.grossAmountCents,
      stripeRefundId: input.stripeRefundId,
      reason: input.reason ?? null,
      lines: input.eventLines ?? [],
    },
    message:
      `Refunded $${(input.grossAmountCents / 100).toFixed(2)}` +
      (input.reason ? ` — ${input.reason}` : ''),
    actorType: input.actorType,
    actorUserId: input.actorUserId ?? null,
  });

  return {
    refundPaymentId: refundRow.id,
    netCollectedCents: net,
    status: target,
  };
}
