import { Inject, Injectable } from '@nestjs/common';
import { Customer } from './entities/customer.entity';
import { PaginatedCustomers } from './entities/paginated-customers.entity';
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
