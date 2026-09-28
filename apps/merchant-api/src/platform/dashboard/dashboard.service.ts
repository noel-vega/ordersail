import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE } from 'src/shared/database/database.constants';
import {
  accountsTable,
  and,
  eq,
  inArray,
  inventoryTable,
  lt,
  orderPaymentsTable,
  ordersTable,
  productsTable,
  productVariantsTable,
  sql,
  type db as Db,
  type SQL,
} from 'db';
import { DashboardSummary } from './entities/dashboard-summary.entity';
import { SALES_PORT, type SalesPort } from './ports/sales.port';
import { DashboardSales, SalesTotals } from './entities/dashboard-sales.entity';
import { resolveRange } from './range';

const RECENT_LIMIT = 5;

// Orders that count as a sale (OS-669). pending / payment_failed never took
// money. canceled is left out entirely — order AND its refund rows — because
// a cancel reverses the whole sale: a paid web cancel writes a refund row but
// a POS cancel writes none (sales/orders/cancel.service.ts), and dropping both
// nets either channel to 0. Trade-off: a cancel removes the sale from the day
// it was placed, retroactively.
const SALE_STATUSES = ['paid', 'partially_refunded', 'refunded'] as const;

// the UTC instant (as a naive UTC timestamp, like every created_at column) of
// the local midnight that starts `date` + `days` in `tz`. The day is added to
// the calendar DATE before the zone conversion: adding interval '1 day' after
// it would be 24h, and a DST day is 23h or 25h long.
function localMidnightUtc(date: string, tz: string, days = 0): SQL {
  return sql`(((${date}::date + ${days}::int)::timestamp) at time zone ${tz}) at time zone 'UTC'`;
}

@Injectable()
export class DashboardService {
  constructor(
    @Inject(DRIZZLE) private readonly db: typeof Db,
    @Inject(SALES_PORT) private readonly sales: SalesPort,
  ) {}

  // point-in-time only — money figures are range-scoped, see getSales
  async getSummary(accountId: number): Promise<DashboardSummary> {
    const [recentOrders, recentCustomers, outOfStockCount] = await Promise.all([
      this.sales.recentOrders(accountId, RECENT_LIMIT),
      this.sales.recentCustomers(accountId, RECENT_LIMIT),
      this.getOutOfStockCount(accountId),
    ]);

    return { outOfStockCount, recentOrders, recentCustomers };
  }

  async getSales(
    accountId: number,
    query: { from?: string; to?: string },
    now = new Date(),
  ): Promise<DashboardSales> {
    const [{ timezone }] = await this.db
      .select({ timezone: accountsTable.timezone })
      .from(accountsTable)
      .where(eq(accountsTable.id, accountId));
    const range = resolveRange({ ...query, timezone, now });

    const [current, previous] = await Promise.all([
      this.getSalesTotals(accountId, timezone, range.from, range.to),
      this.getSalesTotals(
        accountId,
        timezone,
        range.previousFrom,
        range.previousTo,
      ),
    ]);

    return { range: { ...range, timezone }, current, previous };
  }

  // One window's money, `from`..`to` inclusive local dates in `tz`:
  //   gross   = paid orders (SALE_STATUSES) by the ORDER's created_at
  //   refunds = those orders' refund rows (negative order_payments) by the
  //             REFUND's created_at — a refund lands when it happened
  //   net     = gross − refunds
  // amount_total_cents includes shipping; tax is always 0 today.
  private async getSalesTotals(
    accountId: number,
    tz: string,
    from: string,
    to: string,
  ): Promise<SalesTotals> {
    const start = localMidnightUtc(from, tz);
    // exclusive: the local midnight starting the day after `to`
    const end = localMidnightUtc(to, tz, 1);
    const saleOrder = and(
      eq(ordersTable.accountId, accountId),
      inArray(ordersTable.status, [...SALE_STATUSES]),
    );

    const [[orders], [refunds]] = await Promise.all([
      this.db
        .select({
          grossSalesCents: sql<number>`coalesce(sum(${ordersTable.amountTotalCents}), 0)::int`,
          orderCount: sql<number>`count(*)::int`,
        })
        .from(ordersTable)
        .where(
          and(
            saleOrder,
            sql`${ordersTable.createdAt} >= ${start}`,
            sql`${ordersTable.createdAt} < ${end}`,
          ),
        ),
      this.db
        .select({
          refundsCents: sql<number>`coalesce(-sum(${orderPaymentsTable.amountCents}), 0)::int`,
        })
        .from(orderPaymentsTable)
        .innerJoin(ordersTable, eq(ordersTable.id, orderPaymentsTable.orderId))
        .where(
          and(
            saleOrder,
            lt(orderPaymentsTable.amountCents, 0),
            sql`${orderPaymentsTable.createdAt} >= ${start}`,
            sql`${orderPaymentsTable.createdAt} < ${end}`,
          ),
        ),
    ]);

    const { grossSalesCents, orderCount } = orders;
    const { refundsCents } = refunds;
    return {
      grossSalesCents,
      refundsCents,
      netSalesCents: grossSalesCents - refundsCents,
      orderCount,
      averageOrderValueCents:
        orderCount > 0 ? Math.round(grossSalesCents / orderCount) : 0,
    };
  }

  // counted in JS rather than a SQL HAVING clause — simpler to read, and
  // account-scale here doesn't warrant the extra query complexity
  private async getOutOfStockCount(accountId: number) {
    const rows = await this.db
      .select({
        variantId: productVariantsTable.id,
        totalStock: sql<number>`coalesce(sum(${inventoryTable.stock}), 0)::int`,
      })
      .from(productVariantsTable)
      .innerJoin(
        productsTable,
        eq(productsTable.id, productVariantsTable.productId),
      )
      .leftJoin(
        inventoryTable,
        eq(inventoryTable.variantId, productVariantsTable.id),
      )
      .where(eq(productsTable.accountId, accountId))
      .groupBy(productVariantsTable.id);

    return rows.filter((row) => row.totalStock <= 0).length;
  }
}
