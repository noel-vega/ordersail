import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Logger } from 'logging';
import type { OrderJobData } from 'queue';
import { DRIZZLE } from 'src/shared/database/database.constants';
import {
  and,
  desc,
  eq,
  failedOrdersTable,
  isNull,
  orderPaymentsTable,
  sql,
  type db as Db,
} from 'db/sales';
import { CheckoutOrderService } from '../checkout-orders/checkout-order.service';
import { FailedOrder } from './entities/failed-order.entity';
import { FailedOrdersList } from './entities/failed-orders-list.entity';

type FailedOrderRow = typeof failedOrdersTable.$inferSelect;

@Injectable()
export class FailedOrdersService {
  private readonly logger = new Logger(FailedOrdersService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: typeof Db,
    private readonly checkoutOrders: CheckoutOrderService,
  ) {}

  async list(accountId: number): Promise<FailedOrdersList> {
    const [rows, [{ count }]] = await Promise.all([
      this.db
        .select()
        .from(failedOrdersTable)
        .where(eq(failedOrdersTable.accountId, accountId))
        .orderBy(desc(failedOrdersTable.createdAt)),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(failedOrdersTable)
        .where(
          and(
            eq(failedOrdersTable.accountId, accountId),
            isNull(failedOrdersTable.resolvedAt),
          ),
        ),
    ]);

    return { items: rows.map(toEntity), unresolvedCount: count };
  }

  // Idempotent "retry this failed order". Three outcomes:
  //  - already resolved        → return it unchanged (200 no-op)
  //  - order actually exists    → the worker just never resolved the row; do it
  //                               now, attributed to this user
  //  - neither                  → re-enqueue the stored payload; the worker
  //                               writes the order and resolves the row itself
  //                               (CheckoutOrderService.enqueue + the worker's
  //                               stripeCheckoutSessionId guard keep this safe
  //                               to call more than once)
  async retry(
    id: number,
    accountId: number,
    userId: number,
  ): Promise<FailedOrder> {
    const [row] = await this.db
      .select()
      .from(failedOrdersTable)
      .where(
        and(
          eq(failedOrdersTable.id, id),
          eq(failedOrdersTable.accountId, accountId),
        ),
      );
    if (!row) throw new NotFoundException();
    if (row.resolvedAt) return toEntity(row);

    const [existingOrder] = await this.db
      .select({ id: orderPaymentsTable.id })
      .from(orderPaymentsTable)
      .where(
        eq(
          orderPaymentsTable.stripeCheckoutSessionId,
          row.stripeCheckoutSessionId,
        ),
      );

    if (existingOrder) {
      const [resolved] = await this.db
        .update(failedOrdersTable)
        .set({
          resolvedAt: new Date(),
          resolvedBy: `staff:${userId}`,
          updatedAt: new Date(),
        })
        .where(eq(failedOrdersTable.id, id))
        .returning();
      // userId is already on the line via the request's log context
      this.logger.info(
        {
          event: 'failed_order.resolved',
          failedOrderId: id,
          checkoutSessionId: row.stripeCheckoutSessionId,
        },
        'Order already exists — failed order marked resolved',
      );
      return toEntity(resolved);
    }

    await this.checkoutOrders.enqueue(row.payload as OrderJobData);
    this.logger.info(
      {
        event: 'failed_order.retried',
        failedOrderId: id,
        checkoutSessionId: row.stripeCheckoutSessionId,
      },
      'Failed order re-enqueued',
    );
    return toEntity(row);
  }
}

function toEntity(row: FailedOrderRow): FailedOrder {
  const payload = (row.payload ?? {}) as Partial<OrderJobData>;
  return {
    id: row.id,
    stripeCheckoutSessionId: row.stripeCheckoutSessionId,
    stripePaymentIntentId: row.stripePaymentIntentId,
    customerEmail: payload.customerEmail ?? null,
    customerName: payload.customerName ?? null,
    itemCount: payload.items?.reduce((n, i) => n + i.quantity, 0) ?? 0,
    amountTotalCents: payload.amountTotalCents ?? null,
    errorMessage: row.errorMessage,
    attempts: row.attempts,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
