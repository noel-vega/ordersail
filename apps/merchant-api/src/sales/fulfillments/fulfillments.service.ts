import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Shippo } from 'shippo';
import { Logger } from 'logging';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { accountsTable } from 'db/identity';
import { locationsTable } from 'db/stock';
import {
  and,
  type db as Db,
  eq,
  fulfillmentItemsTable,
  fulfillmentsTable,
  inArray,
  orderItemsTable,
  orderShippingTable,
  ordersTable,
} from 'db/sales';
import { OrdersService } from '../orders/orders.service';
import { OrderDetail } from '../orders/entities/order-detail.entity';
import { ShippingRate } from './entities/shipping-rate.entity';
import { GetFulfillmentRatesDto } from './dto/get-fulfillment-rates.dto';
import { CreateFulfillmentDto } from './dto/create-fulfillment.dto';
import { SHIPPO } from './fulfillments.constants';

// same defaults used by storefront-api's checkout-time quoting and the old
// orders.service.ts's getShippingRates — see that module's comment for why
// box dimensions aren't modeled per-product
const DEFAULT_ITEM_WEIGHT_OZ = 16;
const DEFAULT_PARCEL_DIMENSIONS_IN = { length: '12', width: '9', height: '6' };

@Injectable()
export class FulfillmentsService {
  private readonly logger = new Logger(FulfillmentsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: typeof Db,
    private readonly ordersService: OrdersService,
    @Inject(SHIPPO) private readonly shippo: Shippo,
  ) {}

  async getRates(
    dto: GetFulfillmentRatesDto,
    accountId: number,
  ): Promise<ShippingRate[]> {
    const { order, shipping, location, totalWeightOz } =
      await this.resolveRequest(dto, accountId);

    const [account] = await this.db
      .select({ email: accountsTable.email })
      .from(accountsTable)
      .where(eq(accountsTable.id, accountId));

    const shipment = await this.shippo.shipments
      .create({
        addressFrom: {
          name: location.name,
          street1: location.addressLine1!,
          street2: location.addressLine2 ?? undefined,
          city: location.addressCity ?? undefined,
          state: location.addressState ?? undefined,
          zip: location.addressPostalCode ?? undefined,
          country: location.addressCountry ?? 'US',
          phone: location.phone,
          email: account?.email,
        },
        addressTo: {
          name: order.customerName ?? undefined,
          street1: shipping.line1,
          street2: shipping.line2 ?? undefined,
          city: shipping.city,
          state: shipping.state ?? undefined,
          zip: shipping.postalCode,
          country: shipping.country,
        },
        parcels: [
          {
            massUnit: 'oz',
            weight: String(totalWeightOz || DEFAULT_ITEM_WEIGHT_OZ),
            distanceUnit: 'in',
            ...DEFAULT_PARCEL_DIMENSIONS_IN,
          },
        ],
        async: false,
      })
      .catch((err: unknown) => {
        this.logger.error(
          { err, event: 'shippo.shipment_create_failed', orderId: dto.orderId },
          'Shippo shipment creation failed',
        );
        return null;
      });

    if (!shipment || shipment.rates.length === 0) {
      throw new BadRequestException(
        "Couldn't get shipping rates for this order",
      );
    }

    return [...shipment.rates]
      .sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount))
      .map((rate) => ({
        objectId: rate.objectId,
        provider: rate.provider,
        servicelevel: rate.servicelevel.name ?? '',
        amountCents: Math.round(parseFloat(rate.amount) * 100),
        estimatedDays: rate.estimatedDays ?? null,
      }));
  }

  async create(
    dto: CreateFulfillmentDto,
    accountId: number,
  ): Promise<OrderDetail> {
    await this.resolveRequest(dto, accountId);

    // commit the quantity reservation *before* the slow external call, not
    // after — see reserve()'s comment for why this is what actually closes
    // the over-fulfillment race
    const fulfillmentId = await this.reserve(dto);

    const transaction = await this.shippo.transactions
      .create({ rate: dto.rateObjectId, labelFileType: 'PDF', async: false })
      .catch((err: unknown) => {
        this.logger.error(
          {
            err,
            event: 'shippo.label_purchase_failed',
            orderId: dto.orderId,
            fulfillmentId,
          },
          'Shippo label purchase failed',
        );
        return null;
      });

    if (!transaction || transaction.status !== 'SUCCESS') {
      const reason = transaction?.messages
        ?.map((m) => m.text)
        .filter(Boolean)
        .join('; ');
      // a thrown create() was already logged with its err above
      if (transaction) {
        this.logger.error(
          {
            event: 'shippo.label_purchase_failed',
            orderId: dto.orderId,
            fulfillmentId,
            shippoStatus: transaction.status,
            shippoMessages: reason || null,
          },
          'Shippo label purchase did not succeed',
        );
      }
      // release the reservation — nothing was actually shipped, so this
      // quantity is available for a retry or a different fulfillment
      await this.db
        .delete(fulfillmentsTable)
        .where(eq(fulfillmentsTable.id, fulfillmentId));
      throw new BadRequestException(
        reason
          ? `Couldn't purchase a label for that rate: ${reason}`
          : "Couldn't purchase a label for that rate",
      );
    }

    await this.db
      .update(fulfillmentsTable)
      .set({
        shippoTransactionId: transaction.objectId ?? null,
        trackingNumber: transaction.trackingNumber ?? null,
        trackingUrl: transaction.trackingUrlProvider ?? null,
        labelUrl: transaction.labelUrl ?? null,
        updatedAt: new Date(),
      })
      .where(eq(fulfillmentsTable.id, fulfillmentId));
    this.logger.info(
      { event: 'fulfillment.created', orderId: dto.orderId, fulfillmentId },
      'Fulfillment created',
    );

    return (await this.ordersService.findOne(dto.orderId, accountId))!;
  }

  // atomically reserves the requested quantities against each order item.
  // `FOR UPDATE` locks the requested order_items rows so a concurrent
  // create() for the same item blocks here until this transaction commits
  // or rolls back — that's what closes the race resolveRequest's plain
  // SELECT can't close on its own (two concurrent callers could both read
  // the same pre-insert "already fulfilled" sum and both pass validation).
  // Runs — and commits — before the Shippo call in create() so the
  // quantity commitment lands before the slow external request, not after.
  private async reserve(dto: CreateFulfillmentDto): Promise<number> {
    return this.db.transaction(async (tx) => {
      const requestedIds = dto.items.map((i) => i.orderItemId);
      const lockedItems = await tx
        .select({ id: orderItemsTable.id, quantity: orderItemsTable.quantity })
        .from(orderItemsTable)
        .where(inArray(orderItemsTable.id, requestedIds))
        .for('update');

      const fulfilledByItem =
        await this.ordersService.getFulfilledQuantityByItem(requestedIds, tx);

      for (const requested of dto.items) {
        const item = lockedItems.find((i) => i.id === requested.orderItemId)!;
        const remaining = item.quantity - (fulfilledByItem.get(item.id) ?? 0);
        if (requested.quantity > remaining) {
          throw new BadRequestException(
            `Requested quantity for order item ${item.id} (${requested.quantity}) exceeds what's still unfulfilled (${remaining})`,
          );
        }
      }

      const [fulfillment] = await tx
        .insert(fulfillmentsTable)
        .values({
          orderId: dto.orderId,
          locationId: dto.locationId,
          shippingCarrier: dto.provider,
          shippingServiceLevel: dto.servicelevel,
          amountCents: dto.amountCents,
        })
        .returning();

      await tx.insert(fulfillmentItemsTable).values(
        dto.items.map((item) => ({
          fulfillmentId: fulfillment.id,
          orderItemId: item.orderItemId,
          quantity: item.quantity,
        })),
      );

      return fulfillment.id;
    });
  }

  // shared by getRates and create — loads + validates the order, ship-from
  // location, and requested items all belong to this account/order, and
  // that none of the requested quantities exceed what's still unfulfilled.
  // Deliberately does NOT check the requested items against their
  // inventoryMovements allocations for this locationId — allocations are
  // informational (they tell a merchant where stock physically is), not a
  // hard constraint on which location a fulfillment can claim to ship from.
  private async resolveRequest(
    dto: {
      orderId: number;
      locationId: number;
      items: { orderItemId: number; quantity: number }[];
    },
    accountId: number,
  ) {
    const [order] = await this.db
      .select()
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.id, dto.orderId),
          eq(ordersTable.accountId, accountId),
        ),
      );
    if (!order) throw new NotFoundException('Order not found');

    const [shipping] = await this.db
      .select()
      .from(orderShippingTable)
      .where(eq(orderShippingTable.orderId, order.id));
    if (!shipping) {
      throw new BadRequestException(
        'This order has no shipping address to fulfill',
      );
    }

    const [location] = await this.db
      .select()
      .from(locationsTable)
      .where(
        and(
          eq(locationsTable.id, dto.locationId),
          eq(locationsTable.accountId, accountId),
        ),
      );
    if (!location?.addressLine1) {
      throw new BadRequestException(
        'That location has no shipping address on file',
      );
    }
    // checked here rather than left to Shippo, whose rejection (USPS won't
    // quote without an origin phone) comes back as an opaque rate failure
    if (!location.phone) {
      throw new BadRequestException(
        `Add a phone number to ${location.name} before buying a label`,
      );
    }

    const requestedIds = dto.items.map((i) => i.orderItemId);
    const items = await this.db
      .select({
        id: orderItemsTable.id,
        quantity: orderItemsTable.quantity,
        weightOz: orderItemsTable.weightOz,
      })
      .from(orderItemsTable)
      .where(
        and(
          eq(orderItemsTable.orderId, dto.orderId),
          inArray(orderItemsTable.id, requestedIds),
        ),
      );
    if (items.length !== requestedIds.length) {
      throw new BadRequestException(
        "One or more items don't belong to this order",
      );
    }

    // upfront fail-fast check — avoids a pointless Shippo call in the
    // common case. The authoritative check that actually prevents a race
    // is the locked recheck in reserve(), not this one.
    const fulfilledByItem =
      await this.ordersService.getFulfilledQuantityByItem(requestedIds);

    let totalWeightOz = 0;
    for (const requested of dto.items) {
      const item = items.find((i) => i.id === requested.orderItemId)!;
      const alreadyFulfilled = fulfilledByItem.get(item.id) ?? 0;
      const remaining = item.quantity - alreadyFulfilled;
      if (requested.quantity > remaining) {
        throw new BadRequestException(
          `Requested quantity for order item ${item.id} (${requested.quantity}) exceeds what's still unfulfilled (${remaining})`,
        );
      }
      totalWeightOz +=
        (item.weightOz ?? DEFAULT_ITEM_WEIGHT_OZ) * requested.quantity;
    }

    return {
      order,
      shipping,
      // re-spread so the phone check above carries into the type
      location: { ...location, phone: location.phone },
      totalWeightOz,
    };
  }
}
