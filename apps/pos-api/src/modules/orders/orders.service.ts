import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { Logger, setLogContext } from "logging";
import {
  and,
  eq,
  inArray,
  inventoryMovementsTable,
  inventoryTable,
  orderItemsTable,
  orderPaymentsTable,
  ordersTable,
  productOptionsTable,
  productOptionValuesTable,
  productsTable,
  productVariantsTable,
  sql,
  variantOptionValuesTable,
  type db as Db,
} from "db";
import { DRIZZLE } from "../../database/database.constants";
import type { PosDeviceContext } from "../pos-auth/pos-auth.decorators";
import { CreateOrderDto } from "./dto/create-order.dto";
import { PosOrder, PosOrderItem } from "./entities/pos-order.entity";

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(@Inject(DRIZZLE) private readonly db: typeof Db) {}

  async createOrder(
    dto: CreateOrderDto,
    device: PosDeviceContext,
  ): Promise<PosOrder> {
    const variantIds = [...new Set(dto.items.map((i) => i.variantId))];

    // price + snapshot fields come from the DB, never the client — scoped to
    // this device's account and to sellable (active) products only
    const variantRows = await this.db
      .select({
        id: productVariantsTable.id,
        priceCents: productVariantsTable.priceCents,
        sku: productVariantsTable.sku,
        weightOz: productVariantsTable.weightOz,
        productName: productsTable.name,
      })
      .from(productVariantsTable)
      .innerJoin(
        productsTable,
        eq(productsTable.id, productVariantsTable.productId),
      )
      .where(
        and(
          inArray(productVariantsTable.id, variantIds),
          eq(productsTable.accountId, device.accountId),
          eq(productsTable.status, "active"),
        ),
      );
    const byId = new Map(variantRows.map((v) => [v.id, v]));
    const missing = variantIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Unknown or unavailable variant(s): ${missing.join(", ")}`,
      );
    }

    const optionRows = await this.db
      .select({
        variantId: variantOptionValuesTable.variantId,
        optionName: productOptionsTable.name,
        value: productOptionValuesTable.value,
      })
      .from(variantOptionValuesTable)
      .innerJoin(
        productOptionValuesTable,
        eq(productOptionValuesTable.id, variantOptionValuesTable.optionValueId),
      )
      .innerJoin(
        productOptionsTable,
        eq(productOptionsTable.id, productOptionValuesTable.optionId),
      )
      .where(inArray(variantOptionValuesTable.variantId, variantIds));
    const optionsByVariant = new Map<number, string[]>();
    for (const row of optionRows) {
      const list = optionsByVariant.get(row.variantId) ?? [];
      list.push(`${row.optionName}: ${row.value}`);
      optionsByVariant.set(row.variantId, list);
    }

    // merge repeated scans of the same variant into one line
    const qtyByVariant = new Map<number, number>();
    for (const item of dto.items) {
      qtyByVariant.set(
        item.variantId,
        (qtyByVariant.get(item.variantId) ?? 0) + item.quantity,
      );
    }

    const lines = [...qtyByVariant.entries()].map(([variantId, quantity]) => {
      const variant = byId.get(variantId)!;
      const options = optionsByVariant.get(variantId);
      return {
        variantId,
        productName: variant.productName,
        sku: variant.sku,
        optionsLabel:
          options && options.length > 0
            ? options.join(" / ")
            : (variant.sku ?? null),
        priceCents: variant.priceCents,
        quantity,
        weightOz: variant.weightOz,
        lineCents: variant.priceCents * quantity,
      };
    });

    const subtotalCents = lines.reduce((sum, l) => sum + l.lineCents, 0);
    const taxCents = 0;
    const totalCents = subtotalCents + taxCents;

    const method = dto.payment.method;
    let amountTenderedCents: number | null = null;
    let changeCents: number | null = null;
    if (method === "cash") {
      const tendered = dto.payment.amountTenderedCents;
      if (tendered == null || tendered < totalCents) {
        throw new BadRequestException(
          "Cash tendered must be at least the order total",
        );
      }
      amountTenderedCents = tendered;
      changeCents = tendered - totalCents;
    }

    const { order, items } = await this.db.transaction(async (tx) => {
      const recordSoldMovement = async (
        orderItemId: number,
        variantId: number,
        quantity: number,
      ) => {
        const delta = -quantity;
        await tx.insert(inventoryMovementsTable).values({
          orderItemId,
          variantId,
          locationId: device.locationId,
          delta,
          reason: "sold",
        });
        await tx
          .insert(inventoryTable)
          .values({ variantId, locationId: device.locationId, stock: delta })
          .onConflictDoUpdate({
            target: [inventoryTable.variantId, inventoryTable.locationId],
            set: {
              stock: sql`${inventoryTable.stock} + ${delta}`,
              updatedAt: new Date(),
            },
          });
      };

      const [createdOrder] = await tx
        .insert(ordersTable)
        .values({
          accountId: device.accountId,
          channel: "pos",
          status: "paid",
          locationId: device.locationId,
          posDeviceId: device.deviceId,
          subtotalCents,
          taxCents,
          shippingCents: 0,
          amountTotalCents: totalCents,
        })
        .returning();

      const createdItems: PosOrderItem[] = [];
      for (const line of lines) {
        const [orderItem] = await tx
          .insert(orderItemsTable)
          .values({
            orderId: createdOrder.id,
            variantId: line.variantId,
            productName: line.productName,
            sku: line.sku,
            optionsLabel: line.optionsLabel,
            priceCents: line.priceCents,
            quantity: line.quantity,
            weightOz: line.weightOz,
          })
          .returning();

        await recordSoldMovement(orderItem.id, line.variantId, line.quantity);

        createdItems.push({
          id: orderItem.id,
          variantId: orderItem.variantId,
          productName: orderItem.productName,
          sku: orderItem.sku,
          optionsLabel: orderItem.optionsLabel,
          priceCents: orderItem.priceCents,
          quantity: orderItem.quantity,
          lineCents: line.lineCents,
        });
      }

      await tx.insert(orderPaymentsTable).values({
        orderId: createdOrder.id,
        method,
        amountCents: totalCents,
        amountTenderedCents,
      });

      return { order: createdOrder, items: createdItems };
    });
    // after the commit — a rolled-back order ID must never reach the log
    setLogContext({ orderId: order.id });
    this.logger.info(
      {
        event: "order.created",
        channel: "pos",
        paymentMethod: method,
        amountTotalCents: totalCents,
        itemCount: items.length,
      },
      "Order created",
    );

    return {
      id: order.id,
      channel: "pos",
      subtotalCents,
      taxCents,
      totalCents,
      paymentMethod: method,
      amountTenderedCents,
      changeCents,
      createdAt: new Date(order.createdAt).toISOString(),
      items,
    };
  }
}
