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
import {
  DashboardSalesTimeseries,
  type SalesGranularity,
} from './entities/dashboard-sales-timeseries.entity';
import { resolveRange, spanDays } from './range';
import type { DashboardRangeQueryDto } from './dto/dashboard-range-query.dto';

const RECENT_LIMIT = 5;

// Orders that count as a sale (OS-669). pending / payment_failed never took
// money. canceled is left out entirely — order AND its refund rows — because
// a cancel reverses the whole sale: a paid web cancel writes a refund row but
// a POS cancel writes none (sales/orders/cancel.service.ts), and dropping both
// nets either channel to 0. Trade-off: a cancel removes the sale from the day
// it was placed, retroactively.
const SALE_STATUSES = ['paid', 'partially_refunded', 'refunded'] as const;

// WHERE predicate: the account's orders that count as a sale; the query must
// join ordersTable
function isSaleOrder(accountId: number): SQL {
  return and(
    eq(ordersTable.accountId, accountId),
    inArray(ordersTable.status, [...SALE_STATUSES]),
  )!;
}

// the chart's bucket size, from the span in days: ~a point per day up to a
// month, per ISO week (Monday start) up to ~6 months, else per month (OS-670)
export function granularityFor(days: number): SalesGranularity {
  if (days <= 31) return 'day';
  if (days <= 184) return 'week';
  return 'month';
}

const BUCKET_STEP: Record<SalesGranularity, string> = {
  day: '1 day',
  week: '1 week',
  month: '1 month',
};

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
    query: DashboardRangeQueryDto,
    now = new Date(),
  ): Promise<DashboardSales> {
    const { timezone, range } = await this.resolveAccountRange(
      accountId,
      query,
      now,
    );

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

  // The same money as getSales' `current`, split into zero-filled buckets of
  // local dates in the account's zone — so the points always sum to it. Gross
  // and orders bucket by the order's created_at, refunds by the refund's.
  // The first and last buckets may be partial (a range starting mid-week):
  // `date` is still the bucket's start, and only in-range data is counted.
  async getSalesTimeseries(
    accountId: number,
    query: DashboardRangeQueryDto,
    now = new Date(),
  ): Promise<DashboardSalesTimeseries> {
    const { timezone, range } = await this.resolveAccountRange(
      accountId,
      query,
      now,
    );
    const granularity = granularityFor(spanDays(range.from, range.to));
    const start = localMidnightUtc(range.from, timezone);
    const end = localMidnightUtc(range.to, timezone, 1);
    // created_at is a naive UTC timestamp → the local wall-clock date in tz
    const bucketOf = (createdAt: SQL) =>
      sql`date_trunc(${granularity}, (${createdAt} at time zone 'UTC') at time zone ${timezone})`;
    const isSale = isSaleOrder(accountId);

    const { rows } = await this.db.execute<{
      date: string;
      gross: string;
      refunds: string;
      orders: number;
    }>(sql`
      with buckets as (
        select generate_series(
          date_trunc(${granularity}, ${range.from}::date::timestamp),
          ${range.to}::date::timestamp,
          ${BUCKET_STEP[granularity]}::interval
        ) as bucket
      ),
      sales as (
        select ${bucketOf(sql`${ordersTable.createdAt}`)} as bucket,
               sum(${ordersTable.amountTotalCents}) as gross,
               count(*)::int as orders
        from ${ordersTable}
        where ${isSale}
          and ${ordersTable.createdAt} >= ${start}
          and ${ordersTable.createdAt} < ${end}
        group by 1
      ),
      refunds as (
        select ${bucketOf(sql`${orderPaymentsTable.createdAt}`)} as bucket,
               -sum(${orderPaymentsTable.amountCents}) as refunds
        from ${orderPaymentsTable}
        inner join ${ordersTable} on ${ordersTable.id} = ${orderPaymentsTable.orderId}
        where ${isSale}
          and ${orderPaymentsTable.amountCents} < 0
          and ${orderPaymentsTable.createdAt} >= ${start}
          and ${orderPaymentsTable.createdAt} < ${end}
        group by 1
      )
      -- to_char: node-postgres would parse a date into a JS Date in the
      -- server's zone; the bucket is a calendar date, so keep it a string
      select to_char(b.bucket, 'YYYY-MM-DD') as date,
             coalesce(s.gross, 0) as gross,
             coalesce(r.refunds, 0) as refunds,
             coalesce(s.orders, 0) as orders
      from buckets b
      left join sales s on s.bucket = b.bucket
      left join refunds r on r.bucket = b.bucket
      order by b.bucket
    `);

    return {
      granularity,
      from: range.from,
      to: range.to,
      timezone,
      points: rows.map((row) => {
        // sums are bigint, which node-postgres returns as strings
        const grossSalesCents = Number(row.gross);
        const refundsCents = Number(row.refunds);
        return {
          date: row.date,
          grossSalesCents,
          refundsCents,
          netSalesCents: grossSalesCents - refundsCents,
          orderCount: row.orders,
        };
      }),
    };
  }

  private async resolveAccountRange(
    accountId: number,
    query: DashboardRangeQueryDto,
    now: Date,
  ) {
    const [{ timezone }] = await this.db
      .select({ timezone: accountsTable.timezone })
      .from(accountsTable)
      .where(eq(accountsTable.id, accountId));
    return { timezone, range: resolveRange({ ...query, timezone, now }) };
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
    const isSale = isSaleOrder(accountId);

    const [[orders], [refunds]] = await Promise.all([
      this.db
        .select({
          // sum() is bigint — an ::int cast overflows past ~$21.4M a window;
          // node-postgres returns bigint as a string, so map it to a number
          grossSalesCents:
            sql<number>`coalesce(sum(${ordersTable.amountTotalCents}), 0)`.mapWith(
              Number,
            ),
          orderCount: sql<number>`count(*)::int`,
        })
        .from(ordersTable)
        .where(
          and(
            isSale,
            sql`${ordersTable.createdAt} >= ${start}`,
            sql`${ordersTable.createdAt} < ${end}`,
          ),
        ),
      this.db
        .select({
          refundsCents:
            sql<number>`coalesce(-sum(${orderPaymentsTable.amountCents}), 0)`.mapWith(
              Number,
            ),
        })
        .from(orderPaymentsTable)
        .innerJoin(ordersTable, eq(ordersTable.id, orderPaymentsTable.orderId))
        .where(
          and(
            isSale,
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
