import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE } from '../../../database/database.constants';
import { resolvePageParams } from '../../../shared/pagination';
import {
  and,
  desc,
  eq,
  fulfillmentItemsTable,
  inArray,
  orderItemsTable,
  ordersTable,
  sql,
  type db as Db,
} from 'db';
import { ListCustomerOrdersQueryDto } from './dto/list-customer-orders-query.dto';
import { PaginatedCustomerOrders } from './entities/paginated-customer-orders.entity';
import { deriveFulfillmentStatus } from './order-status';

// Read-only order history for the signed-in customer. Every query is scoped by
// customerId AND accountId: CustomerAuthGuard already rejects a token from a
// different tenant's app key, but the accountId filter keeps the query itself
// tenant-safe rather than relying on that guard alone.
@Injectable()
export class CustomerOrdersService {
  constructor(@Inject(DRIZZLE) private readonly db: typeof Db) {}

  async findAll(
    { limit, offset }: ListCustomerOrdersQueryDto,
    customerId: number,
    accountId: number,
  ): Promise<PaginatedCustomerOrders> {
    const { limit: take, offset: skip } = resolvePageParams(limit, offset);
    const where = and(
      eq(ordersTable.customerId, customerId),
      eq(ordersTable.accountId, accountId),
    );

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select({
          id: ordersTable.id,
          status: ordersTable.status,
          amountTotalCents: ordersTable.amountTotalCents,
          createdAt: ordersTable.createdAt,
          itemCount: sql<number>`coalesce(sum(${orderItemsTable.quantity}), 0)::int`,
        })
        .from(ordersTable)
        .leftJoin(orderItemsTable, eq(orderItemsTable.orderId, ordersTable.id))
        .where(where)
        .groupBy(ordersTable.id)
        .orderBy(desc(ordersTable.createdAt), desc(ordersTable.id))
        .limit(take)
        .offset(skip),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(ordersTable)
        .where(where),
    ]);

    const fulfilledByOrder = await this.getFulfilledQuantityByOrder(
      rows.map((o) => o.id),
    );

    return {
      items: rows.map((order) => ({
        id: order.id,
        status: order.status,
        fulfillmentStatus: deriveFulfillmentStatus(
          order.itemCount,
          fulfilledByOrder.get(order.id) ?? 0,
        ),
        itemCount: order.itemCount,
        amountTotalCents: order.amountTotalCents,
        createdAt: order.createdAt,
      })),
      total,
      limit: take,
      offset: skip,
    };
  }

  private async getFulfilledQuantityByOrder(
    orderIds: number[],
  ): Promise<Map<number, number>> {
    if (orderIds.length === 0) return new Map();

    const rows = await this.db
      .select({
        orderId: orderItemsTable.orderId,
        fulfilled: sql<number>`coalesce(sum(${fulfillmentItemsTable.quantity}), 0)::int`,
      })
      .from(fulfillmentItemsTable)
      .innerJoin(
        orderItemsTable,
        eq(orderItemsTable.id, fulfillmentItemsTable.orderItemId),
      )
      .where(inArray(orderItemsTable.orderId, orderIds))
      .groupBy(orderItemsTable.orderId);

    return new Map(rows.map((r) => [r.orderId, r.fulfilled]));
  }
}
