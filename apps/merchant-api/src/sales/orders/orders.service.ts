import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { inventoryMovementsTable, locationsTable } from 'db/stock';
import { usersTable } from 'db/identity';
import {
  and,
  type db as Db,
  desc,
  eq,
  fulfillmentItemsTable,
  fulfillmentsTable,
  inArray,
  orderEventsTable,
  orderItemsTable,
  orderPaymentsTable,
  orderShippingTable,
  ordersTable,
  sql,
} from 'db/sales';
import { PaginatedOrders } from './entities/paginated-orders.entity';
import {
  OrderDetail,
  type FulfillmentStatus,
} from './entities/order-detail.entity';
import { OrderStatusChange } from './entities/order-status-change.entity';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { transitionOrderStatus } from './order-status';
import type { Fulfillment } from '../fulfillments/entities/fulfillment.entity';

const MAX_LIMIT = 100;

function deriveFulfillmentStatus(
  totalQuantity: number,
  fulfilledQuantity: number,
): FulfillmentStatus {
  if (fulfilledQuantity <= 0) return 'unfulfilled';
  if (fulfilledQuantity >= totalQuantity) return 'fulfilled';
  return 'partially_fulfilled';
}

@Injectable()
export class OrdersService {
  constructor(@Inject(DRIZZLE) private readonly db: typeof Db) {}

  async findAll(
    limit: number,
    offset: number,
    accountId: number,
  ): Promise<PaginatedOrders> {
    const clampedLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);
    const clampedOffset = Math.max(offset, 0);

    const [items, [{ total }]] = await Promise.all([
      this.db
        .select({
          id: ordersTable.id,
          channel: ordersTable.channel,
          status: ordersTable.status,
          customerName: ordersTable.customerName,
          customerEmail: ordersTable.customerEmail,
          amountTotalCents: ordersTable.amountTotalCents,
          createdAt: ordersTable.createdAt,
          itemCount: sql<number>`coalesce(sum(${orderItemsTable.quantity}), 0)::int`,
        })
        .from(ordersTable)
        .leftJoin(orderItemsTable, eq(orderItemsTable.orderId, ordersTable.id))
        .where(eq(ordersTable.accountId, accountId))
        .groupBy(ordersTable.id)
        .orderBy(desc(ordersTable.createdAt))
        .limit(clampedLimit)
        .offset(clampedOffset),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(ordersTable)
        .where(eq(ordersTable.accountId, accountId)),
    ]);

    const fulfilledByOrder = await this.getFulfilledQuantityByOrder(
      items.map((o) => o.id),
    );

    return {
      items: items.map((order) => ({
        ...order,
        fulfillmentStatus: deriveFulfillmentStatus(
          order.itemCount,
          fulfilledByOrder.get(order.id) ?? 0,
        ),
      })),
      total,
      limit: clampedLimit,
      offset: clampedOffset,
    };
  }

  async findOne(
    id: number,
    accountId: number,
  ): Promise<OrderDetail | undefined> {
    const [order] = await this.db
      .select()
      .from(ordersTable)
      .where(and(eq(ordersTable.id, id), eq(ordersTable.accountId, accountId)));
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
      .where(eq(orderItemsTable.orderId, order.id));
    const itemIds = itemRows.map((i) => i.id);

    const [
      allocationRows,
      fulfilledByItem,
      fulfillments,
      [shipping],
      payments,
      events,
    ] = await Promise.all([
      this.getAllocations(itemIds),
      this.getFulfilledQuantityByItem(itemIds),
      this.getFulfillments(order.id),
      this.db
        .select({
          line1: orderShippingTable.line1,
          line2: orderShippingTable.line2,
          city: orderShippingTable.city,
          state: orderShippingTable.state,
          postalCode: orderShippingTable.postalCode,
          country: orderShippingTable.country,
          locationId: orderShippingTable.locationId,
        })
        .from(orderShippingTable)
        .where(eq(orderShippingTable.orderId, order.id)),
      this.db
        .select({
          method: orderPaymentsTable.method,
          amountCents: orderPaymentsTable.amountCents,
          amountTenderedCents: orderPaymentsTable.amountTenderedCents,
          stripeRefundId: orderPaymentsTable.stripeRefundId,
          reason: orderPaymentsTable.reason,
        })
        .from(orderPaymentsTable)
        .where(eq(orderPaymentsTable.orderId, order.id))
        .orderBy(orderPaymentsTable.id),
      this.getEvents(order.id),
    ]);

    const items = itemRows.map((item) => {
      const fulfilledQuantity = fulfilledByItem.get(item.id) ?? 0;
      return {
        ...item,
        fulfilledQuantity,
        remainingQuantity: item.quantity - fulfilledQuantity,
        allocations: allocationRows
          .filter((a) => a.orderItemId === item.id)
          .map(({ locationId, locationName, quantity }) => ({
            locationId,
            locationName,
            quantity,
          })),
      };
    });

    const totalQuantity = itemRows.reduce((sum, i) => sum + i.quantity, 0);
    const totalFulfilled = items.reduce(
      (sum, i) => sum + i.fulfilledQuantity,
      0,
    );

    return {
      id: order.id,
      channel: order.channel,
      status: order.status,
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      shipping: shipping ?? null,
      payments,
      subtotalCents: order.subtotalCents,
      amountTotalCents: order.amountTotalCents,
      shippingCents: order.shippingCents,
      fulfillmentStatus: deriveFulfillmentStatus(totalQuantity, totalFulfilled),
      createdAt: order.createdAt,
      items,
      fulfillments,
      events,
    };
  }

  // the order's audit trail, newest first, with staff names resolved
  private async getEvents(orderId: number): Promise<OrderDetail['events']> {
    const rows = await this.db
      .select({
        id: orderEventsTable.id,
        type: orderEventsTable.type,
        message: orderEventsTable.message,
        actorType: orderEventsTable.actorType,
        createdAt: orderEventsTable.createdAt,
        firstname: usersTable.firstname,
        lastname: usersTable.lastname,
      })
      .from(orderEventsTable)
      .leftJoin(usersTable, eq(usersTable.id, orderEventsTable.actorUserId))
      .where(eq(orderEventsTable.orderId, orderId))
      .orderBy(desc(orderEventsTable.createdAt), desc(orderEventsTable.id));

    return rows.map(({ firstname, lastname, ...event }) => ({
      ...event,
      actorName: firstname ? `${firstname} ${lastname}` : null,
    }));
  }

  // Narrow manual status correction (PATCH /orders/:id/status). Refund states
  // are reached through the refund flow (OS-121/122), never set by hand here.
  async updateStatus(
    id: number,
    accountId: number,
    dto: UpdateOrderStatusDto,
    actorUserId: number,
  ): Promise<OrderStatusChange> {
    if (dto.status === 'refunded' || dto.status === 'partially_refunded') {
      throw new ConflictException(
        `Set '${dto.status}' via a refund (POST /orders/${id}/refunds), not a manual status change`,
      );
    }

    return this.db.transaction(async (tx) => {
      const [order] = await tx
        .select({ id: ordersTable.id })
        .from(ordersTable)
        .where(
          and(eq(ordersTable.id, id), eq(ordersTable.accountId, accountId)),
        );
      if (!order) throw new NotFoundException();

      const { from, to } = await transitionOrderStatus(tx, {
        orderId: id,
        to: dto.status,
        actorType: 'staff',
        actorUserId,
        reason: dto.reason ?? null,
      });

      return { id, status: to, previousStatus: from };
    });
  }

  // sum of fulfillment_items.quantity per order, for the given order ids —
  // a separate query rather than joining fulfillmentItemsTable into the
  // paginated query above, which would fan out and double-count itemCount
  // once an item has more than one fulfillment
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

  // public, and takes an optional executor, so FulfillmentsService can reuse
  // this instead of keeping its own copy — both for a plain fail-fast check
  // (default this.db) and, inside a locked transaction, for the
  // authoritative check that actually closes the over-fulfillment race (see
  // FulfillmentsService.create)
  async getFulfilledQuantityByItem(
    itemIds: number[],
    executor: Pick<typeof Db, 'select'> = this.db,
  ): Promise<Map<number, number>> {
    if (itemIds.length === 0) return new Map();

    const rows = await executor
      .select({
        orderItemId: fulfillmentItemsTable.orderItemId,
        fulfilled: sql<number>`coalesce(sum(${fulfillmentItemsTable.quantity}), 0)::int`,
      })
      .from(fulfillmentItemsTable)
      .where(inArray(fulfillmentItemsTable.orderItemId, itemIds))
      .groupBy(fulfillmentItemsTable.orderItemId);

    return new Map(rows.map((r) => [r.orderItemId, r.fulfilled]));
  }

  // how much of an order item's stock came from which location, derived
  // from the checkout worker's inventory movements rather than a separate
  // allocation table kept in sync with them
  private async getAllocations(itemIds: number[]): Promise<
    {
      orderItemId: number;
      locationId: number;
      locationName: string;
      quantity: number;
    }[]
  > {
    if (itemIds.length === 0) return [];

    const rows = await this.db
      .select({
        orderItemId: inventoryMovementsTable.orderItemId,
        locationId: inventoryMovementsTable.locationId,
        locationName: locationsTable.name,
        quantity: sql<number>`sum(-${inventoryMovementsTable.delta})::int`,
      })
      .from(inventoryMovementsTable)
      .innerJoin(
        locationsTable,
        eq(locationsTable.id, inventoryMovementsTable.locationId),
      )
      .where(
        and(
          inArray(inventoryMovementsTable.orderItemId, itemIds),
          eq(inventoryMovementsTable.reason, 'sold'),
        ),
      )
      .groupBy(
        inventoryMovementsTable.orderItemId,
        inventoryMovementsTable.locationId,
        locationsTable.name,
      );

    return rows.map((r) => ({ ...r, orderItemId: r.orderItemId! }));
  }

  private async getFulfillments(orderId: number): Promise<Fulfillment[]> {
    const fulfillmentRows = await this.db
      .select({
        id: fulfillmentsTable.id,
        locationId: fulfillmentsTable.locationId,
        locationName: locationsTable.name,
        shippingCarrier: fulfillmentsTable.shippingCarrier,
        shippingServiceLevel: fulfillmentsTable.shippingServiceLevel,
        trackingNumber: fulfillmentsTable.trackingNumber,
        trackingUrl: fulfillmentsTable.trackingUrl,
        labelUrl: fulfillmentsTable.labelUrl,
        amountCents: fulfillmentsTable.amountCents,
        createdAt: fulfillmentsTable.createdAt,
      })
      .from(fulfillmentsTable)
      .innerJoin(
        locationsTable,
        eq(locationsTable.id, fulfillmentsTable.locationId),
      )
      .where(eq(fulfillmentsTable.orderId, orderId))
      .orderBy(fulfillmentsTable.createdAt);
    if (fulfillmentRows.length === 0) return [];

    const fulfillmentIds = fulfillmentRows.map((f) => f.id);
    const itemRows = await this.db
      .select({
        fulfillmentId: fulfillmentItemsTable.fulfillmentId,
        orderItemId: fulfillmentItemsTable.orderItemId,
        quantity: fulfillmentItemsTable.quantity,
      })
      .from(fulfillmentItemsTable)
      .where(inArray(fulfillmentItemsTable.fulfillmentId, fulfillmentIds));

    return fulfillmentRows.map((f) => ({
      ...f,
      items: itemRows
        .filter((i) => i.fulfillmentId === f.id)
        .map(({ orderItemId, quantity }) => ({ orderItemId, quantity })),
    }));
  }
}
