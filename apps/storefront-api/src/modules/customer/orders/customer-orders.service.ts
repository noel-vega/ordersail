import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE } from '../../../database/database.constants';
import { resolvePageParams } from '../../../shared/pagination';
import {
  and,
  desc,
  eq,
  fulfillmentItemsTable,
  fulfillmentsTable,
  inArray,
  orderItemsTable,
  orderPaymentsTable,
  orderRefundLinesTable,
  orderShippingTable,
  ordersTable,
  sql,
  type db as Db,
} from 'db';
import { ListCustomerOrdersQueryDto } from './dto/list-customer-orders-query.dto';
import { PaginatedCustomerOrders } from './entities/paginated-customer-orders.entity';
import { CustomerOrderDetail } from './entities/customer-order-detail.entity';
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

  // undefined when the order doesn't exist or isn't this customer's — the
  // controller turns both into the same 404, so an id probe can't tell
  // "someone else's order" apart from "no such order"
  async findOne(
    id: number,
    customerId: number,
    accountId: number,
  ): Promise<CustomerOrderDetail | undefined> {
    const [order] = await this.db
      .select()
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.id, id),
          eq(ordersTable.customerId, customerId),
          eq(ordersTable.accountId, accountId),
        ),
      );
    if (!order) return undefined;

    const itemRows = await this.db
      .select({
        id: orderItemsTable.id,
        variantId: orderItemsTable.variantId,
        productName: orderItemsTable.productName,
        sku: orderItemsTable.sku,
        optionsLabel: orderItemsTable.optionsLabel,
        priceCents: orderItemsTable.priceCents,
        quantity: orderItemsTable.quantity,
      })
      .from(orderItemsTable)
      .where(eq(orderItemsTable.orderId, order.id))
      .orderBy(orderItemsTable.id);
    const itemIds = itemRows.map((i) => i.id);

    const [
      fulfilledByItem,
      refundedByItem,
      fulfillments,
      [shipping],
      payments,
    ] = await Promise.all([
      this.getFulfilledQuantityByItem(itemIds),
      this.getRefundedQuantityByItem(itemIds),
      this.getFulfillments(order.id),
      this.db
        .select({
          line1: orderShippingTable.line1,
          line2: orderShippingTable.line2,
          city: orderShippingTable.city,
          state: orderShippingTable.state,
          postalCode: orderShippingTable.postalCode,
          country: orderShippingTable.country,
        })
        .from(orderShippingTable)
        .where(eq(orderShippingTable.orderId, order.id)),
      this.db
        .select({
          method: orderPaymentsTable.method,
          amountCents: orderPaymentsTable.amountCents,
          createdAt: orderPaymentsTable.createdAt,
        })
        .from(orderPaymentsTable)
        .where(eq(orderPaymentsTable.orderId, order.id))
        .orderBy(orderPaymentsTable.id),
    ]);

    const items = itemRows.map((item) => ({
      ...item,
      fulfilledQuantity: fulfilledByItem.get(item.id) ?? 0,
      refundedQuantity: refundedByItem.get(item.id) ?? 0,
    }));
    const totalQuantity = items.reduce((sum, i) => sum + i.quantity, 0);
    const totalFulfilled = items.reduce(
      (sum, i) => sum + i.fulfilledQuantity,
      0,
    );

    return {
      id: order.id,
      status: order.status,
      fulfillmentStatus: deriveFulfillmentStatus(totalQuantity, totalFulfilled),
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      shipping: shipping ?? null,
      subtotalCents: order.subtotalCents,
      shippingCents: order.shippingCents,
      taxCents: order.taxCents,
      amountTotalCents: order.amountTotalCents,
      payments,
      items,
      fulfillments,
      createdAt: order.createdAt,
    };
  }

  private async getFulfilledQuantityByItem(
    itemIds: number[],
  ): Promise<Map<number, number>> {
    if (itemIds.length === 0) return new Map();

    const rows = await this.db
      .select({
        orderItemId: fulfillmentItemsTable.orderItemId,
        fulfilled: sql<number>`coalesce(sum(${fulfillmentItemsTable.quantity}), 0)::int`,
      })
      .from(fulfillmentItemsTable)
      .where(inArray(fulfillmentItemsTable.orderItemId, itemIds))
      .groupBy(fulfillmentItemsTable.orderItemId);

    return new Map(rows.map((r) => [r.orderItemId, r.fulfilled]));
  }

  private async getRefundedQuantityByItem(
    itemIds: number[],
  ): Promise<Map<number, number>> {
    if (itemIds.length === 0) return new Map();

    const rows = await this.db
      .select({
        orderItemId: orderRefundLinesTable.orderItemId,
        refunded: sql<number>`coalesce(sum(${orderRefundLinesTable.quantity}), 0)::int`,
      })
      .from(orderRefundLinesTable)
      .where(inArray(orderRefundLinesTable.orderItemId, itemIds))
      .groupBy(orderRefundLinesTable.orderItemId);

    return new Map(rows.map((r) => [r.orderItemId, r.refunded]));
  }

  private async getFulfillments(
    orderId: number,
  ): Promise<CustomerOrderDetail['fulfillments']> {
    const fulfillmentRows = await this.db
      .select({
        id: fulfillmentsTable.id,
        shippingCarrier: fulfillmentsTable.shippingCarrier,
        shippingServiceLevel: fulfillmentsTable.shippingServiceLevel,
        trackingNumber: fulfillmentsTable.trackingNumber,
        trackingUrl: fulfillmentsTable.trackingUrl,
        createdAt: fulfillmentsTable.createdAt,
      })
      .from(fulfillmentsTable)
      .where(eq(fulfillmentsTable.orderId, orderId))
      .orderBy(fulfillmentsTable.createdAt, fulfillmentsTable.id);
    if (fulfillmentRows.length === 0) return [];

    const itemRows = await this.db
      .select({
        fulfillmentId: fulfillmentItemsTable.fulfillmentId,
        orderItemId: fulfillmentItemsTable.orderItemId,
        quantity: fulfillmentItemsTable.quantity,
      })
      .from(fulfillmentItemsTable)
      .where(
        inArray(
          fulfillmentItemsTable.fulfillmentId,
          fulfillmentRows.map((f) => f.id),
        ),
      );

    return fulfillmentRows.map((f) => ({
      ...f,
      items: itemRows
        .filter((i) => i.fulfillmentId === f.id)
        .map(({ orderItemId, quantity }) => ({ orderItemId, quantity })),
    }));
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
