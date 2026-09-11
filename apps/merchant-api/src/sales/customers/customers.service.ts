import { Inject, Injectable } from '@nestjs/common';
import { Customer } from './entities/customer.entity';
import { CustomerDetail } from './entities/customer-detail.entity';
import { PaginatedCustomers } from './entities/paginated-customers.entity';
import { PaginatedCustomerOrders } from './entities/paginated-customer-orders.entity';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { resolvePageParams } from 'src/shared/pagination';
import {
  and,
  customersTable,
  type db as Db,
  desc,
  eq,
  ilike,
  or,
  ordersTable,
  sql,
  type SQL,
} from 'db/sales';

export function toCustomer(row: typeof customersTable.$inferSelect): Customer {
  return {
    id: row.id,
    accountId: row.accountId,
    firstName: row.firstname,
    lastName: row.lastname,
    email: row.email,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class CustomersService {
  constructor(@Inject(DRIZZLE) private readonly db: typeof Db) {}

  async findAll(
    limit: number,
    offset: number,
    accountId: number,
    q?: string,
  ): Promise<PaginatedCustomers> {
    const { limit: take, offset: skip } = resolvePageParams(limit, offset);
    const where = this.filter(accountId, q);

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(customersTable)
        .where(where)
        .orderBy(desc(customersTable.createdAt), desc(customersTable.id))
        .limit(take)
        .offset(skip),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(customersTable)
        .where(where),
    ]);

    return { items: rows.map(toCustomer), total, limit: take, offset: skip };
  }

  // the N most recently created customers — used by the dashboard read-model
  async findRecent(accountId: number, limit: number): Promise<Customer[]> {
    const rows = await this.db
      .select()
      .from(customersTable)
      .where(eq(customersTable.accountId, accountId))
      .orderBy(desc(customersTable.createdAt))
      .limit(limit);

    return rows.map(toCustomer);
  }

  async findOne(
    id: number,
    accountId: number,
  ): Promise<CustomerDetail | undefined> {
    const [row] = await this.db
      .select()
      .from(customersTable)
      .where(
        and(eq(customersTable.id, id), eq(customersTable.accountId, accountId)),
      );
    if (!row) return undefined;

    const lifetimeValueCents = await this.getLifetimeValueCents(id, accountId);
    return { ...toCustomer(row), lifetimeValueCents };
  }

  // sum of amountTotalCents across every order linked to this customer via
  // orders.customerId (OS-189) — same coalesce/sum convention as
  // DashboardService.getOrderTotals
  private async getLifetimeValueCents(
    customerId: number,
    accountId: number,
  ): Promise<number> {
    const [row] = await this.db
      .select({
        total: sql<number>`coalesce(sum(${ordersTable.amountTotalCents}), 0)::int`,
      })
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.customerId, customerId),
          eq(ordersTable.accountId, accountId),
        ),
      );

    return row.total;
  }

  async findOrders(
    customerId: number,
    accountId: number,
    limit: number,
    offset: number,
  ): Promise<PaginatedCustomerOrders> {
    const { limit: take, offset: skip } = resolvePageParams(limit, offset);
    const where = and(
      eq(ordersTable.customerId, customerId),
      eq(ordersTable.accountId, accountId),
    );

    const [items, [{ total }]] = await Promise.all([
      this.db
        .select({
          id: ordersTable.id,
          channel: ordersTable.channel,
          status: ordersTable.status,
          amountTotalCents: ordersTable.amountTotalCents,
          createdAt: ordersTable.createdAt,
        })
        .from(ordersTable)
        .where(where)
        .orderBy(desc(ordersTable.createdAt), desc(ordersTable.id))
        .limit(take)
        .offset(skip),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(ordersTable)
        .where(where),
    ]);

    return { items, total, limit: take, offset: skip };
  }

  private filter(accountId: number, q?: string): SQL | undefined {
    const scope = eq(customersTable.accountId, accountId);
    const term = q?.trim();
    if (!term) return scope;

    const like = `%${term}%`;
    return and(
      scope,
      or(
        ilike(customersTable.firstname, like),
        ilike(customersTable.lastname, like),
        ilike(customersTable.email, like),
      ),
    );
  }
}
